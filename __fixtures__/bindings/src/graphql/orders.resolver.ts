export class OrdersResolver {
  // NestJS names the field inside an options object, which str_args never sees.
  // Without reading it back this would be recorded as Query.findAll.
  @Query(() => [String], { name: 'orders' })
  findAll() { return []; }
}
