package com.shop.kafka;

/** The producer side: it names the topic a listener elsewhere handles. */
public class OrderProducer {
  private Object kafkaTemplate;

  public void ship(String payload) {
    kafkaTemplate.send("shipments", "key", payload);
  }

  /** A topic named by configuration, which this plugin must refuse to guess. */
  public void configured(String payload) {
    kafkaTemplate.send("${app.topic.audit}", "key", payload);
  }
}
