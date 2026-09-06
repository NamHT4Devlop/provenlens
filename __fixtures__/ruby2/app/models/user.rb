class User < ApplicationRecord
  include Auditable
  attr_accessor :name

  before_save :normalize, if: :needs_normalize?
  validate :check_name

  scope :visible, -> { where(hidden: false).merge(Policy.allowed) }

  def initialize(name)
    @name = name
    @policy = Policy.new
  end

  class << self
    def build
      helper
      new
    end

    def helper; end
  end

  def helper; end

  def rename(other)
    other.name = "x"
    other.name += "y"
    self.name = "z"
  end

  def touch_it
    super()
  end

  def logger = LogAdapter.new(self)

  def normalize; end
  def needs_normalize?; true; end
  def check_name; end

  define_method(:dyn) do
    helper
  end

  alias_method :older_name, :name
  alias newest_name name
end
