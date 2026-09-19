# frozen_string_literal: true

# Access-code management (design D4.1). In production, run these from the CapRover app console.
namespace :access_codes do
  desc "Create a code. LABEL=\"Side project\" [EXPIRES_IN=30d|12h|90m]. Prints the code once."
  task create: :environment do
    label = ENV.fetch("LABEL") { abort "LABEL is required, e.g. LABEL=\"Side project\"" }
    expires_in = ENV["EXPIRES_IN"]
    expires_at = expires_in.presence && AccessCodes::Duration.parse(expires_in).from_now

    record, plaintext = AccessCode.generate!(label:, expires_at:)
    puts "Created access code ##{record.id} (#{record.label})" \
         "#{", expires #{record.expires_at&.iso8601}" if record.expires_at}"
    puts
    puts "  #{plaintext}"
    puts
    puts "This is the only time the code is shown."
  rescue ArgumentError, ActiveRecord::RecordInvalid => e
    abort e.message
  end

  desc "List codes (never shows the codes themselves)"
  task list: :environment do
    rows = AccessCode.order(:id).map do |code|
      status = if code.revoked_at then "revoked"
      elsif code.active? then "active"
      else "expired"
      end
      [
        code.id.to_s, status, code.label,
        code.created_at.utc.strftime("%F %R"),
        code.expires_at&.utc&.strftime("%F %R") || "never",
        code.last_used_at&.utc&.strftime("%F %R") || "never"
      ]
    end
    header = %w[ID STATUS LABEL CREATED(UTC) EXPIRES(UTC) LAST_USED(UTC)]
    widths = header.each_index.map { |i| ([ header ] + rows).map { |row| row[i].length }.max }
    ([ header ] + rows).each { |row| puts row.each_with_index.map { |cell, i| cell.ljust(widths[i]) }.join("  ") }
    puts "(no access codes)" if rows.empty?
  end

  desc "Revoke a code immediately. ID=123"
  task revoke: :environment do
    id = ENV.fetch("ID") { abort "ID is required, e.g. ID=3 (see access_codes:list)" }
    code = AccessCode.find_by(id:) or abort "No access code with ID #{id}"
    code.revoke!
    puts "Revoked access code ##{code.id} (#{code.label}); its sessions end on their next request."
  end
end
