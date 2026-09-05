// KafkaJS puts the topic inside an object, so `str_args` never sees it.
export async function startAudit(consumer: any) {
  await consumer.subscribe({ topic: 'audit-log', fromBeginning: true });
}

export async function emitOrder(producer: any) {
  // Reaches the Java listener above, across a language boundary.
  await producer.send({ topic: 'shipments', messages: [{ value: 'x' }] });
}
