import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ strict: false })
export class Product {
  @Prop({ required: true })
  product_id: string; // e.g. PRD001-BLK-128

  @Prop()
  parent_product_id?: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true })
  sku: string;

  @Prop({ required: true })
  brand: string;

  @Prop({ required: true })
  category: string;

  @Prop()
  subcategory?: string;

  @Prop()
  short_description?: string;

  @Prop()
  long_description?: string;

  @Prop()
  specification?: string;

  @Prop({ type: Object, default: {} })
  attributes: Record<string, any>;

  @Prop({ required: true })
  price: number;

  @Prop({ type: Object })
  dimensions?: {
    length?: number;
    width?: number;
    height?: number;
    weight?: number;
  };

  @Prop({ type: [String], default: [] })
  images?: string[]; // URLs to images

  @Prop({ type: Buffer })
  image_blob?: Buffer; // optional direct image data

  @Prop({ required: true, index: true })
  party_id: string; // Link product to party who owns/registered it

  @Prop()
  video_url?: string;


  @Prop({ default: Date.now })
  created_at?: Date;

  @Prop()
  updated_at?: Date;

  @Prop({ type: Object, default: () => ({}) })
  tally_account?: {
    company_name: string;
    company_number: number;
  };

  @Prop()
  other?: string;


}

export const ProductSchema = SchemaFactory.createForClass(Product);