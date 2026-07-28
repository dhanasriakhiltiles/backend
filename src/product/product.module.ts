import { Module,forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { UserService } from 'src/user/user.service';
import { UserModule } from 'src/user/user.module';
import { User, UserSchema } from 'src/user/schemas/user.schema';
import { Inventory, InventorySchema } from './schemas/inventory.schema';
import { Party, PartySchema } from '../user/schemas/party.schema';
import { Offer, OfferSchema } from './schemas/offer.schema';
import { OfferService } from './offer.service';
import { OfferController } from './offer.controller';
import { PreOrder, PreOrderSchema } from './schemas/preorder.schema';
import { PreOrderService } from './preorder.service';
import { PreOrderController } from './preorder.controller';
import { Retailerfield, RetailerfieldSchema } from '../user/schemas/retailerfields.schema';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';



@Module({
  imports: [MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema },
    { name: User.name, schema: UserSchema },
    { name: Inventory.name, schema: InventorySchema },
    {name:Party.name, schema: PartySchema},
    { name: Product.name, schema: ProductSchema },
    { name: Offer.name, schema: OfferSchema },
    { name: PreOrder.name, schema: PreOrderSchema },
    { name: Retailerfield.name, schema: RetailerfieldSchema },
    
     ]),CloudinaryModule,
  forwardRef(() =>UserModule)],
  providers: [ProductService,OfferService, PreOrderService, UserService],
  controllers: [ProductController, OfferController, PreOrderController],
  exports: [MongooseModule]
})
export class ProductModule {}
