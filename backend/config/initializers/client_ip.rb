# frozen_string_literal: true

# Client IPs for rate limiting (design D4.3). Behind CapRover's nginx, Rack derives the client IP
# from proxy headers. It prefers the RFC 7239 `Forwarded` header, which nginx passes through
# untouched — so a client could send its own and pick any IP. Only trust X-Forwarded-For, which
# nginx appends the real client address to.
Rack::Request.forwarded_priority = [ :x_forwarded ]
