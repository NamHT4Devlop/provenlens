require_relative 'order'
require_relative 'user'

class Service
  # `thing` is a parameter with no type anywhere: `thing.save` matches both
  # Order#save and User#save, and the resolver records it as ambiguous rather
  # than drawing an edge to one of them.
  def run(thing)
    thing.save
  end

  def known
    User.new.name
  end
end
