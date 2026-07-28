// preorder.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PreOrderDocument = PreOrder & Document;

/**
 * PreOrder collection — stores pre-booked quantity for a product.
 *
 * Design: Separate collection (NOT embedded in product) so that Tally syncs
 * (which $set/reset product fields) never wipe pre-order data. Follows the
 * same pattern as the Offer collection.
 *
 * Multiple active entries per product are allowed (e.g. 10 boxes pre-booked
 * by Retailer A, 5 by Retailer B). The SUM of active entries = total
 * pre-ordered quantity, which is subtracted from inventory to show
 * "available quantity" to retailers.
 */
@Schema({ timestamps: true })
export class PreOrder {
  @Prop({ required: true })
  product_id: string;

  @Prop({ required: true })
  party_id: string;

  // The pre-ordered quantity (e.g., 10 boxes)
  @Prop({ required: true })
  quantity: number;

  // Toggle: true  = show quantity badge to retailers
  //         false = highlight only (no number shown to retailers)
  @Prop({ type: Boolean, default: true })
  show_quantity: boolean;

  // Optional note/label (e.g., "Pre-booked by Retailer X") — admin only
  @Prop()
  note?: string;

  // Who created this pre-order entry (admin userid)
  @Prop({ required: true })
  created_by: string;

  // Active or cleared. Admin can deactivate without deleting (audit trail).
  @Prop({ type: Boolean, default: true })
  is_active: boolean;

  // Custom badge text shown to retailers when show_quantity is false
  @Prop({ type: String, default: 'Trending' })
  badge_text?: string;
}

export const PreOrderSchema = SchemaFactory.createForClass(PreOrder);
