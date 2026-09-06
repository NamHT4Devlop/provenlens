Point = Struct.new(:x, :y) do
  def dist
    x + y
  end
end

Derived = Class.new(Policy) do
  def hello
    allowed
  end
end

class Uses
  def run
    Point.new(1, 2).dist
    Derived.new.hello
  end
end
