def build_user
  User.new("spec")
end

describe "User" do
  it "does things" do
    u = build_user
    u.save
    response.body
  end
end
