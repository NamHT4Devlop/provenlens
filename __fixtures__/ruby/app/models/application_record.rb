class ApplicationRecord < ActiveRecord::Base
  def save
    persist!
  end

  def persist!
    true
  end
end
