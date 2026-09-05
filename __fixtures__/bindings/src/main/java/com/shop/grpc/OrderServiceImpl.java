package com.shop.grpc;

/** grpc-java generates OrderServiceGrpc.OrderServiceImplBase; this implements it. */
public class OrderServiceImpl extends OrderServiceGrpc.OrderServiceImplBase {

  /** The generated base lowers the proto's first letter: GetOrder -> getOrder. */
  @Override
  public void getOrder(Object request, Object observer) {}

  @Override
  public void listOrders(Object request, Object observer) {}
}
