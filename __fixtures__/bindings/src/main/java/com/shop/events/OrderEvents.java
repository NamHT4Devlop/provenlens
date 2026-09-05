package com.shop.events;

/** The publisher: it constructs the event a listener elsewhere declares. */
public class OrderEvents {
  private Object publisher;

  public void place(String id) {
    publisher.publishEvent(new OrderPlaced(id));
  }

  /** A publish whose receiver says nothing about events must not be claimed. */
  public void unrelated(Object bus) {
    bus.publish(new OrderPlaced("x"));
  }

  /** Two constructors on one line: the event is the outer one. */
  public void nested(String id) {
    publisher.publishEvent(new OrderPlaced(new OrderId(id)));
  }
}
