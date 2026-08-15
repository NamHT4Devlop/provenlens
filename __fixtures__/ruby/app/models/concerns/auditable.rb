module Auditable
  def audit(action)
    Rails.logger.info("[audit] #{action}")
  end

  def audited?
    true
  end
end
