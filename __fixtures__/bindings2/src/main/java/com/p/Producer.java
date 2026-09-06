package com.p;

import org.springframework.kafka.core.KafkaTemplate;

public class Producer {
  KafkaTemplate<String, String> kafkaTemplate;
  void a() { kafkaTemplate.send("orders", "k", "v"); }
}
