package com.shop.route;

import org.apache.camel.builder.RouteBuilder;

public class OrderRoute extends RouteBuilder {

    @Override
    public void configure() {
        from("direct:receiveOrder")
            .log("received")
            .to("direct:validateOrder");

        from("direct:validateOrder")
            .to("seda:persistOrder?concurrentConsumers=5");

        from("seda:persistOrder")
            .to("aws2-sqs:order-events");
    }
}
