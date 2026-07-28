import { Controller, Post, Body, Get, Query, Delete, Param, Patch, UseGuards, Req } from '@nestjs/common';
import { PreOrderService } from './preorder.service';
import { PreOrderDocument } from './schemas/preorder.schema';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('preorder')
export class PreOrderController {
  constructor(private readonly preOrderService: PreOrderService) {}

  /**
   * Create a pre-order entry (admin only).
   * Body: { product_id, party_id, quantity, show_quantity?, note?, created_by }
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  async createPreOrder(@Body() data: any) {
    const preOrder = await this.preOrderService.createPreOrder(data);
    const obj = (preOrder as PreOrderDocument).toObject();
    return { ...obj, id: obj._id };
  }

  /**
   * Get all pre-orders for admin (by party_id from JWT).
   */
  @Get('admin')
  @UseGuards(JwtAuthGuard)
  async getPreOrdersForAdmin(@Req() req) {
    const partyId = req.user.partyid;
    const preOrders = await this.preOrderService.getPreOrdersForAdmin(partyId);
    return preOrders.map((po) => {
      const obj = (po as PreOrderDocument).toObject();
      return { ...obj, id: obj._id };
    });
  }

  /**
   * Get active pre-orders for a specific product.
   * Query: ?product_id=PRD1001
   */
  @Get('active')
  async getActivePreOrders(@Query('product_id') productId: string) {
    return this.preOrderService.getActivePreOrdersForProduct(productId);
  }

  /**
   * Update a pre-order (toggle show_quantity, change quantity, edit note).
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async updatePreOrder(@Param('id') id: string, @Body() data: any) {
    const preOrder = await this.preOrderService.updatePreOrder(id, data);
    if (!preOrder) return null;
    const obj = (preOrder as PreOrderDocument).toObject();
    return { ...obj, id: obj._id };
  }

  /**
   * Deactivate (clear) a pre-order — keeps record for audit.
   */
  @Delete(':id/deactivate')
  @UseGuards(JwtAuthGuard)
  async deactivatePreOrder(@Param('id') id: string) {
    return this.preOrderService.deactivatePreOrder(id);
  }

  /**
   * Delete a pre-order permanently.
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async removePreOrder(@Param('id') id: string) {
    return this.preOrderService.removePreOrder(id);
  }
}
