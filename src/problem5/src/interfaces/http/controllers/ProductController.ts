import type { Request, Response } from 'express';
import type { ProductService } from '../../../application/product/ProductService';
import type { Product } from '../../../domain/product/Product';
import type { ListProductsQuery } from '../../../domain/product/ProductRepository';
import {
  DEFAULT_LIST_LIMIT,
  createProductSchema,
  ifMatchHeaderSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  updateProductSchema,
} from '../schemas/product';

/**
 * The API representation of a product.
 *
 * Declared explicitly rather than returning the domain object directly. The two
 * happen to match today, but a response body is a published contract: leaking
 * whatever fields the domain grows next - internal flags, cost price, supplier
 * notes - is how private data escapes without anyone deciding to publish it.
 * Adding a field here is a decision; forgetting to remove one is an accident.
 */
interface ProductResponse {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  priceMinor: number;
  currency: string;
  stock: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function present(product: Product): ProductResponse {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    priceMinor: product.priceMinor,
    currency: product.currency,
    stock: product.stock,
    isActive: product.isActive,
    version: product.version,
    // ISO-8601 with an explicit offset. Serialising a Date directly would work
    // by accident today and break the moment anything changes how it is
    // stringified; a timestamp without a zone is a bug waiting for a deploy to
    // a differently-configured host.
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

/**
 * HTTP adapter for the product resource.
 *
 * It does three things and nothing else: parse and validate the request, call
 * one service method, and shape the response. There is no business logic here -
 * that belongs in `application/`, where it can be tested without HTTP.
 *
 * Errors are thrown, never caught. Express 5 forwards a rejected promise from a
 * handler to the error middleware automatically, so the single error handler
 * decides every status code. Try/catch in each method would scatter that
 * decision across the codebase and guarantee inconsistency.
 */
export class ProductController {
  public constructor(private readonly service: ProductService) {}

  public create = async (req: Request, res: Response): Promise<void> => {
    const body = createProductSchema.parse(req.body);
    const product = await this.service.create({
      sku: body.sku,
      name: body.name,
      description: body.description,
      category: body.category,
      priceMinor: body.priceMinor,
      currency: body.currency,
      stock: body.stock,
      isActive: body.isActive,
    });

    res
      .status(201)
      // Location tells the client where the thing it just made now lives,
      // which is what 201 is specified to do.
      .location(`${req.baseUrl}/${product.id}`)
      .set('ETag', `"${product.version}"`)
      .json(present(product));
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    const query = listProductsQuerySchema.parse(req.query);

    const listQuery: ListProductsQuery = {
      filter: {
        category: query.category,
        currency: query.currency,
        minPriceMinor: query.minPrice,
        maxPriceMinor: query.maxPrice,
        inStock: query.inStock,
        isActive: query.isActive,
        q: query.q,
      },
      // Newest first is the useful default for an inventory: it is what someone
      // browsing without an opinion actually wants to see.
      sort: query.sort ?? { field: 'createdAt', direction: 'desc' },
      limit: query.limit ?? DEFAULT_LIST_LIMIT,
      cursor: query.cursor,
    };

    const page = await this.service.list(listQuery);
    res.status(200).json({
      items: page.items.map(present),
      // Deliberately no `total`. Counting the filtered set costs a second pass
      // over the same rows to answer a question keyset pagination never needs -
      // and the number is stale the moment it is computed.
      nextCursor: page.nextCursor,
    });
  };

  public getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = productIdParamSchema.parse(req.params);
    const product = await this.service.getById(id);
    res.status(200).set('ETag', `"${product.version}"`).json(present(product));
  };

  public update = async (req: Request, res: Response): Promise<void> => {
    const { id } = productIdParamSchema.parse(req.params);
    const patch = updateProductSchema.parse(req.body);

    // If-Match is optional. Supplying it makes the write conditional on nobody
    // having modified the row since the client read it; omitting it is
    // last-write-wins, which is documented rather than accidental.
    const ifMatch = req.get('if-match');
    const expectedVersion =
      ifMatch === undefined ? undefined : ifMatchHeaderSchema.parse(ifMatch);

    const product = await this.service.update(id, patch, expectedVersion);
    res.status(200).set('ETag', `"${product.version}"`).json(present(product));
  };

  public remove = async (req: Request, res: Response): Promise<void> => {
    const { id } = productIdParamSchema.parse(req.params);
    await this.service.delete(id);
    // 204 with no body: there is nothing meaningful to return, and an empty
    // JSON object would only invite clients to parse it.
    res.status(204).send();
  };
}
