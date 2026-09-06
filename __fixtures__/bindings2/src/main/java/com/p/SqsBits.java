package com.p;

import io.awspring.cloud.sqs.annotation.SqsListener;
import io.awspring.cloud.sqs.operations.SqsTemplate;

public class SqsBits {
  SqsTemplate sqsTemplate;

  @SqsListener(value = "orders", factory = "myFactory")
  void onOrder(String m) { }

  void enqueue() { sqsTemplate.send("orders", "payload"); }
}
