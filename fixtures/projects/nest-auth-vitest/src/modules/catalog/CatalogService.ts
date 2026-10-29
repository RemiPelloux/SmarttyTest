export interface Product {
  id: string;
  price: number;
}

export class CatalogService {
  private readonly products: Product[] = [
    { id: "p1", price: 10 },
    { id: "p2", price: 32 },
  ];

  list(): Product[] {
    return this.products;
  }

  total(): number {
    return this.products.reduce((sum, p) => sum + p.price, 0);
  }
}
