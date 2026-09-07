# Four declarations of `id`: a name this common says nothing about which
# test covers which change, so the automatic list in `affected` skips it.
class Alpha
  def id
    1
  end
end

class Beta
  def id
    2
  end
end

class Gamma
  def id
    3
  end
end

class Delta
  def id
    4
  end
end
