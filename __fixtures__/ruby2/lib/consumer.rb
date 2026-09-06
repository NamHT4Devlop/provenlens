class Consumer
  def go
    u = User.new("a")
    u.save
    u.audit
    u.logger.info("x")
  end
end
