class DonationsController < ApplicationController
  def index
    @donations = Donation.all
  end

  def create
    donation = DonationRecorder.call(current_donor, params[:amount])
    render json: donation.summary
  end

  def total
    render json: current_donor.total_given
  end

  private

  def current_donor
    Donor.new
  end
end
