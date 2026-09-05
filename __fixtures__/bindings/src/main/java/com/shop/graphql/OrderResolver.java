package com.shop.graphql;

/** Spring GraphQL: the annotation names the root, the method names the field. */
public class OrderResolver {

  @QueryMapping
  public Object orders(int first) { return null; }

  /** The annotation overrides the method name. */
  @QueryMapping("orderById")
  public Object byId(String id) { return null; }

  @MutationMapping
  public Object placeOrder(String input) { return null; }

  @SchemaMapping(typeName = "Order", field = "customer")
  public Object customerOf(Object order) { return null; }
}
