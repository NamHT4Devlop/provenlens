package com.p;

import org.springframework.kafka.annotation.KafkaListener;

public class Listeners2 {
  @KafkaListener(
      groupId = "late",
      containerFactory = "factory",
      topics = "late-topic")
  void late(String m) { }

  @KafkaListener(topics = {
      "multi-a",
      "multi-b",
      "multi-c"}, groupId = "multi")
  void multi(String m) { }
}
