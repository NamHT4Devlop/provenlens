class DonorNotifier
  def notify(donor)
    donor.total_given
  end

  def skip(widget)
    widget.total_given
  end
end
