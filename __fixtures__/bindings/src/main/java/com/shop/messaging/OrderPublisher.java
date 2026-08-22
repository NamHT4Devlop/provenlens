package com.shop.messaging;

import io.awspring.cloud.sqs.operations.SqsTemplate;

public class OrderPublisher {

    private final SqsTemplate sqsTemplate;

    public OrderPublisher(SqsTemplate sqsTemplate) {
        this.sqsTemplate = sqsTemplate;
    }

    public void publish(String payload) {
        sqsTemplate.send("order-events", payload);
    }
}
