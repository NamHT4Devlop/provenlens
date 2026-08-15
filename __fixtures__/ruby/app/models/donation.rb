class Donation < ApplicationRecord
  belongs_to :donor
  has_many :line_items, dependent: :destroy

  validates :amount, presence: true

  scope :large, -> { where("amount > ?", 1000) }

  def large?
    amount > 1000
  end

  def summary
    "#{donor.name}: #{formatted_amount}"
  end

  def formatted_amount
    format("%.2f", amount)
  end
end
