class SettingsStore
  def method_missing(key, *args)
    lookup(key)
  end

  def respond_to_missing?(key, include_private = false)
    true
  end

  def lookup(key)
    key
  end
end
