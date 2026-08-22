package com.shop.messaging;

import io.awspring.cloud.sqs.annotation.SqsListener;

public class OrderListener {

    @SqsListener("order-events")
    public void handleOrder(String payload) {
        process(payload);
    }

    private void process(String payload) {
        System.out.println(payload);
    }
}
