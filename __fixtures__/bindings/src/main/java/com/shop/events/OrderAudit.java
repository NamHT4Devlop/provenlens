package com.shop.events;

/** The listener: where the work for OrderPlaced actually happens. */
public class OrderAudit {

  @EventListener
  public void onPlaced(OrderPlaced event) {
    record(event);
  }

  /** A different event, published nowhere in this fixture. */
  @TransactionalEventListener
  public void onShipped(OrderShipped event) {}

  /** Object is a name two unrelated methods share by accident. */
  @EventListener
  public void onAnything(Object event) {}

  private void record(Object e) {}
}
