require_relative '../lib/order'

describe Order do
  it 'saves with arguments' do
    record = make_record
    record.save(1, 2, 3)
    record.id
  end
end
