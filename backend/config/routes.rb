Rails.application.routes.draw do
  # format: false — rack-attack throttles these exact paths, so no "/graphql.json" variants.
  post "/graphql", to: "graphql#execute", format: false

  namespace :api do
    resource :session, only: %i[create destroy], format: false
  end
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Everything else is a client-side route of the single-page app (design D1.6).
  root "spa#show"
  get "*path", to: "spa#show", constraints: ->(request) { request.format.html? }
end
