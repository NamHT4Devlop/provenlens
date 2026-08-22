class OrderWorker
  include Shoryuken::Worker

  shoryuken_options queue: 'order-events', auto_delete: true

  def perform(sqs_msg, body)
    body
  end
end
