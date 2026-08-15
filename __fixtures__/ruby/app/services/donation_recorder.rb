class DonationRecorder
  include Auditable

  def self.call(donor, amount)
    new(donor, amount).record
  end

  def initialize(donor, amount)
    @donor = donor
    @amount = amount
  end

  def record
    audit("recording donation")
    donation = Donation.new(donor: @donor, amount: @amount)
    donation.save
    donation
  end

  def total_for_donor
    @donor.total_given
  end
end
