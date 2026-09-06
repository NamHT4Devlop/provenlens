package com.p;

import java.util.Map;
import org.springframework.web.client.RestTemplate;

public class OrderClient {
  RestTemplate rest;
  Map<String, String> m;
  void a() { rest.getForObject("/api/orders/42", String.class); }
  void b() { rest.postForObject("/api/orders/bulk", null, String.class); }
  void c() { rest.getForObject("/api/orders/list", String.class); }
  void mapPut() { m.put("/api/orders/42", "x"); }
}
