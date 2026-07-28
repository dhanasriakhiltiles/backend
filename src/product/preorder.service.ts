import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PreOrder, PreOrderDocument } from './schemas/preorder.schema';

@Injectable()
export class PreOrderService {
  constructor(
    @InjectModel(PreOrder.name) private readonly preOrderModel: Model<PreOrderDocument>,
  ) {}

  /**
   * Create a new pre-order entry.
   * Multiple active entries per product are allowed; they are summed
   * to compute the total pre-ordered quantity.
   */
  async createPreOrder(data: Partial<PreOrder>): Promise<PreOrder> {
    const { product_id, party_id, quantity } = data;

    if (!product_id || !party_id || quantity === undefined) {
      throw new BadRequestException('Missing required pre-order fields (product_id, party_id, quantity)');
    }
    if (quantity <= 0) {
      throw new BadRequestException('Pre-order quantity must be greater than 0');
    }

    const preOrder = new this.preOrderModel({
      product_id,
      party_id,
      quantity,
      show_quantity: data.show_quantity !== undefined ? data.show_quantity : true,
      note: data.note || '',
      badge_text: data.badge_text !== undefined ? data.badge_text : 'Trending',
      created_by: data.created_by,
      is_active: true,
    });
    return preOrder.save();
  }

  /**
   * Get all active pre-orders for a product.
   * The SUM of these entries = total pre-ordered quantity.
   */
  async getActivePreOrdersForProduct(productId: string): Promise<PreOrderDocument[]> {
    return this.preOrderModel
      .find({ product_id: productId, is_active: true })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * Get total pre-ordered quantity for a product (sum of all active entries).
   */
  async getTotalPreOrderQuantity(productId: string): Promise<number> {
    const preOrders = await this.getActivePreOrdersForProduct(productId);
    return preOrders.reduce((sum, po) => sum + (po.quantity || 0), 0);
  }

  /**
   * Get all pre-orders for an admin (party_id) — includes inactive for audit.
   */
  async getPreOrdersForAdmin(partyId: string): Promise<PreOrderDocument[]> {
    return this.preOrderModel
      .find({ party_id: partyId })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Update a pre-order (e.g., toggle show_quantity, change quantity, edit note).
   */
  async updatePreOrder(id: string, data: Partial<PreOrder>): Promise<PreOrderDocument | null> {
    if (data.quantity !== undefined && data.quantity <= 0) {
      throw new BadRequestException('Pre-order quantity must be greater than 0');
    }
    return this.preOrderModel.findByIdAndUpdate(
      id,
      { $set: data },
      { new: true },
    );
  }

  /**
   * Deactivate (clear) a pre-order — keeps the record for audit trail.
   */
  async deactivatePreOrder(id: string): Promise<{ success: boolean }> {
    const result = await this.preOrderModel.findByIdAndUpdate(
      id,
      { $set: { is_active: false } },
      { new: true },
    );
    if (!result) throw new NotFoundException('Pre-order not found');
    return { success: true };
  }

  /**
   * Delete a pre-order permanently.
   */
  async removePreOrder(id: string) {
    const result = await this.preOrderModel.findByIdAndDelete(id);
    if (!result) throw new BadRequestException('Pre-order not found');
    return { success: true, message: 'Pre-order removed' };
  }

  /**
   * Delete all pre-orders for a product (called when product is deleted).
   */
  async deletePreOrdersByProductId(productId: string): Promise<{ deletedCount: number }> {
    const result = await this.preOrderModel.deleteMany({ product_id: productId });
    return { deletedCount: result.deletedCount };
  }
}
