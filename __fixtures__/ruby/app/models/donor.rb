class Donor < ApplicationRecord
  has_many :donations

  attr_reader :name

  def total_given
    donations.sum(&:amount)
  end
end
