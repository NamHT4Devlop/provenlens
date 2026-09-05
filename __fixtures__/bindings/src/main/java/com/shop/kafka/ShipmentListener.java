package com.shop.kafka;

/** The consumer side of `shipments`: where a message on that topic is handled. */
public class ShipmentListener {

  @KafkaListener(topics = "shipments", groupId = "shipping-service")
  public void onShipment(String payload) {
    record(payload);
  }

  // Two topics on one handler, with the group id sitting in the same argument
  // list -- the case that makes reading the attribute name necessary.
  @KafkaListener(topics = {"returns", "refunds"}, groupId = "returns-service")
  public void onReturn(String payload) {}

  private void record(String payload) {}
}
