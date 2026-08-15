class ApplicationRecord
  def save
    persist!
  end

  def persist!
    true
  end
end
