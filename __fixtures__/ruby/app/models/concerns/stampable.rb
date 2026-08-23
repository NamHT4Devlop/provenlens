module Stampable
  included do
    has_one :stamp
    attr_reader :stamped_at
  end

  def stamp!
    stamped_at
  end
end
