class Receipt < ApplicationRecord
  include Stampable
  belongs_to :donor
  delegate :name, to: :donor

  def header
    name
  end

  def sealed?
    stamp!
  end

  def config_value
    SettingsStore.new.theme_color
  end
end
