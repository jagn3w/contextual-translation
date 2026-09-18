Rails.application.routes.draw do
  post "/graphql", to: "graphql#execute"

  namespace :api do
    resource :session, only: %i[create destroy]
  end
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Everything else is a client-side route of the single-page app (design D1.6).
  root "spa#show"
  get "*path", to: "spa#show", constraints: ->(request) { request.format.html? }
end
