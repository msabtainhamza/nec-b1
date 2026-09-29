import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  createItemGroupRequest,
  createItemRequest,
  createPriceListRequest,
  createUnitRequest,
  createWarehouseRequest,
  itemListQuery,
  stockMovementQuery,
  paginationQuery,
  setPricesRequest,
  updateItemRequest,
  updatePriceListRequest,
  updateWarehouseRequest,
  type Item,
  type ItemGroup,
  type ItemStock,
  type ItemSummary,
  type Page,
  type PriceList,
  type PriceListEntry,
  type StockMovement,
  type UnitOfMeasure,
  type Warehouse,
} from '@nec/contracts';
import { z } from 'zod';
import { RequirePermission } from '../auth/auth.guard.js';
import { parseInput } from '../common/errors.js';
import { CorrelationId, CurrentPrincipal, tenantPrincipal, type Principal } from '../common/request-context.js';
import { InventoryService } from './inventory.service.js';
import { StockService } from './stock.service.js';

const priceEntriesQuery = paginationQuery.extend({ search: z.string().trim().max(100).optional() });

@Controller('v1/inv')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly stock: StockService,
  ) {}

  @RequirePermission('inv.stock.view')
  @Get('items/:id/stock')
  itemStock(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<ItemStock> {
    return this.stock.itemStock(tenantPrincipal(principal), id);
  }

  @RequirePermission('inv.stock.view')
  @Get('stock-movements')
  movements(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<StockMovement>> {
    return this.stock.movements(tenantPrincipal(principal), parseInput(stockMovementQuery, query));
  }

  @RequirePermission('inv.item.view')
  @Get('units')
  units(@CurrentPrincipal() principal: Principal): Promise<UnitOfMeasure[]> {
    return this.inventory.units(tenantPrincipal(principal));
  }

  @RequirePermission('inv.setup.administer')
  @Post('units')
  createUnit(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<UnitOfMeasure> {
    return this.inventory.createUnit(tenantPrincipal(principal), parseInput(createUnitRequest, body), correlationId);
  }

  @RequirePermission('inv.item.view')
  @Get('item-groups')
  groups(@CurrentPrincipal() principal: Principal): Promise<ItemGroup[]> {
    return this.inventory.groups(tenantPrincipal(principal));
  }

  @RequirePermission('inv.setup.administer')
  @Post('item-groups')
  createGroup(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<ItemGroup> {
    return this.inventory.createGroup(tenantPrincipal(principal), parseInput(createItemGroupRequest, body), correlationId);
  }

  @RequirePermission('inv.item.view')
  @Get('warehouses')
  warehouses(@CurrentPrincipal() principal: Principal): Promise<Warehouse[]> {
    return this.inventory.warehouses(tenantPrincipal(principal));
  }

  @RequirePermission('inv.setup.administer')
  @Post('warehouses')
  createWarehouse(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<Warehouse> {
    return this.inventory.createWarehouse(tenantPrincipal(principal), parseInput(createWarehouseRequest, body), correlationId);
  }

  @RequirePermission('inv.setup.administer')
  @Put('warehouses/:id')
  updateWarehouse(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<Warehouse> {
    return this.inventory.updateWarehouse(tenantPrincipal(principal), id, parseInput(updateWarehouseRequest, body), correlationId);
  }

  @RequirePermission('inv.price.view')
  @Get('price-lists')
  priceLists(@CurrentPrincipal() principal: Principal): Promise<PriceList[]> {
    return this.inventory.priceLists(tenantPrincipal(principal));
  }

  @RequirePermission('inv.price.administer')
  @Post('price-lists')
  createPriceList(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<PriceList> {
    return this.inventory.createPriceList(tenantPrincipal(principal), parseInput(createPriceListRequest, body), correlationId);
  }

  @RequirePermission('inv.price.administer')
  @Put('price-lists/:id')
  updatePriceList(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<PriceList> {
    return this.inventory.updatePriceList(tenantPrincipal(principal), id, parseInput(updatePriceListRequest, body), correlationId);
  }

  @RequirePermission('inv.price.view')
  @Get('price-lists/:id/prices')
  priceEntries(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
  ): Promise<Page<PriceListEntry>> {
    const parsed = parseInput(priceEntriesQuery, query);
    return this.inventory.priceListEntries(tenantPrincipal(principal), id, parsed.search, parsed.limit, parsed.offset);
  }

  @RequirePermission('inv.price.administer')
  @Put('price-lists/:id/prices')
  @HttpCode(204)
  async setPrices(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    await this.inventory.setPrices(tenantPrincipal(principal), id, parseInput(setPricesRequest, body), correlationId);
  }

  @RequirePermission('inv.item.view')
  @Get('items')
  items(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<ItemSummary>> {
    return this.inventory.items(tenantPrincipal(principal), parseInput(itemListQuery, query));
  }

  @RequirePermission('inv.item.view')
  @Get('items/:id')
  item(@CurrentPrincipal() principal: Principal, @Param('id', new ParseUUIDPipe()) id: string): Promise<Item> {
    return this.inventory.item(tenantPrincipal(principal), id);
  }

  @RequirePermission('inv.item.create')
  @Post('items')
  createItem(@CurrentPrincipal() principal: Principal, @Body() body: unknown, @CorrelationId() correlationId: string): Promise<Item> {
    return this.inventory.createItem(tenantPrincipal(principal), parseInput(createItemRequest, body), correlationId);
  }

  @RequirePermission('inv.item.edit')
  @Put('items/:id')
  updateItem(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
  ): Promise<Item> {
    return this.inventory.updateItem(tenantPrincipal(principal), id, parseInput(updateItemRequest, body), correlationId);
  }
}
