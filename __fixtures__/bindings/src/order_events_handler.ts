export class OrderEventsHandler {
  @SqsMessageHandler('order-events', false)
  handle(message: string): void {
    this.audit(message);
  }

  audit(message: string): void {}
}

export class ShipmentPublisher {
  constructor(private sqsService: SqsService) {}

  notifyShipped(payload: string): void {
    this.sqsService.send('order-events', payload);
  }
}
