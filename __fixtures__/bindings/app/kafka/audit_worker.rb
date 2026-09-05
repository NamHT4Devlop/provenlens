# Karafka names the topic in a routing block.
class AuditWorker
  def consume
    Karafka::App.routes.draw do
      topic :audit-log do
        consumer AuditWorker
      end
    end
  end

  def forward(payload)
    Karafka.producer.produce_async(topic: 'shipments', payload: payload)
  end
end
