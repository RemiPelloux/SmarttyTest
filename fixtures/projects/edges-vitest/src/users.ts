type Db = { user: { count(): Promise<number> }; order: { count(): Promise<number> } };

export async function countUsers(db: Db): Promise<number> {
  return db.user.count();
}

export async function countOrders(db: Db): Promise<number> {
  return db.order.count();
}
