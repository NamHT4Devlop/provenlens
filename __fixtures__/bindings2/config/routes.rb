Rails.application.routes.draw do
  # Comments carry a hash sign; 'things#archive' below is not one.
  namespace :api do
    resources :things, only: [:show] do
      member do
        post :archive
      end
    end
    post 'things/:id/restore', to: 'things#restore'
  end
  scope '/v1', module: 'v1' do
    get 'status', to: 'status#show'
  end
  get '/legacy' => 'legacy#index'
  root to: 'home#index'
end
