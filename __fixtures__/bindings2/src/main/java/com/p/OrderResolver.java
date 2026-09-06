package com.p;

import org.springframework.graphql.data.method.annotation.*;

public class OrderResolver {
  @QueryMapping
  public String orders(int first, String after) { return ""; }

  @Deprecated
  @QueryMapping("orderById")
  public String byId(String id) { return ""; }

  @SchemaMapping(field = "customer", typeName = "Order")
  public String customerOf(String order) { return ""; }
}
