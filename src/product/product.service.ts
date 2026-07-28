import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product } from './schemas/product.schema';
import { User } from 'src/user/schemas/user.schema';
import { UserService } from 'src/user/user.service';
import { Inventory, InventoryDocument } from './schemas/inventory.schema';
import { Offer } from './schemas/offer.schema';
import { OfferService } from './offer.service';
import { PreOrderService } from './preorder.service';
import { Retailerfield } from '../user/schemas/retailerfields.schema';

@Injectable()
export class ProductService {
  constructor(@InjectModel(Product.name) private productModel: Model<Product>,
              @InjectModel(User.name) private userModel: Model<User>,
            private readonly UserService: UserService,
            @InjectModel(Inventory.name) private inventoryModel: Model<Inventory>,
            private readonly offerService: OfferService,
            private readonly preOrderService: PreOrderService,
            @InjectModel(Retailerfield.name) private retailerfieldModel: Model<Retailerfield>) {}

  async addproduct(data: any): Promise<Product> {
    const admin = await this.userModel.findById(data.created_by); // MongoDB _id
    if (!admin) throw new NotFoundException('User not found');
    const adminid = admin.userid;
    const party = await this.UserService.findpartyidbyuserid(adminid);

    const lastProduct = await this.productModel
                        .findOne({ product_id: { $regex: /^PRD\d+$/ } }) // match custom IDs
                        .sort({ product_id: -1 }) // sort descending
                        .exec();

    let newProductId = 'PRD100'; // default starting point

    if (lastProduct) {
      const lastId = String(lastProduct.product_id); // ensure it's a string
      const lastNum = parseInt(lastId.replace('PRD', ''), 10);
      newProductId = `PRD${lastNum + 1}`;
    }
    
    const newProduct = new this.productModel({
      product_id: newProductId,
      sku : data.sku,
      name : data.name,
      long_description : data.long_description,
      short_description : data.short_description,
      specification : data.specification,
      price : data.price,
      images: Array.isArray(data.images) ? data.images : (typeof data.images === 'string' ? data.images.split(',').map((s: string) => s.trim()) : []),
      category : data.category,
      subcategory : data.subcategory,
      brand : data.brand,
      created_at : new Date(),      
      updated_at : new Date(),
      party_id: party,
    });

    return newProduct.save();
  }

  async addinventory(data: any): Promise<Inventory> {
    const newinventory = new this.inventoryModel({
      product_id: data.product_id,

      quantity: data.quantity,

      batch_no: data.batch_no,

      expiry_date: data.expiry_date,

      updated_at: new Date(),

    });

    return newinventory.save();

  }

  async getAdminProducts(docid): Promise<any> {
    const userid = await this.UserService.finduseridbydocumentid(docid);
    const partyid = await this.UserService.findpartyidbyuserid(userid);
    const adminprod = await this.productModel.find({party_id : partyid}).select('product_id name sku brand short_description long_description dimensions images category subcategory specification attributes price video_url updated_at' )
    const adminproducts = await Promise.all(adminprod.map(async (product) => {
      const inventory = await this.inventoryModel.findOne({
        product_id:  product.product_id,});
      // Fetch active offers for this product
      const offers = await this.offerService.getActiveOffersForProduct(product.product_id);

      // Fetch active pre-orders for this product
      const preOrders = await this.preOrderService.getActivePreOrdersForProduct(product.product_id);
      const totalPreOrderQty = preOrders.reduce((sum, po) => sum + (po.quantity || 0), 0);
      const showQuantity = preOrders.some(po => po.show_quantity);
      const hasPreOrder = preOrders.length > 0;
      const inventoryQty = inventory?.quantity || 0;
      const availableQty = Math.max(0, inventoryQty - totalPreOrderQty);

      return {
        product_id: product.product_id,
        name: product.name,
        sku: product.sku,
        brand: product.brand,
        short_description : product.short_description,
        long_description: product.long_description,
        dimensions: product.dimensions,
        images: product.images,
        category : product.category,
        subcategory : product.subcategory,
        specification : product.specification,
        attributes : product.attributes,
        price: product.price,
        video_url: (product as any).video_url,
        updated_at: (product as any).updated_at,
        inventory: inventory ,
        offers, // Attach offers array (could be empty)
        preOrder: hasPreOrder ? {
          totalQuantity: totalPreOrderQty,
          showQuantity: showQuantity,
          availableQuantity: availableQty,
          hasHighlight: true,
          badgeText: preOrders.find(po => po.badge_text)?.badge_text || 'Trending',
          entries: preOrders, // Admin sees all entries
        } : null,
      };
    }));
    
    return adminproducts;
  }

  async getRetailerProducts(docid): Promise<any> {
    let retailerProd: any[] = [];
    const user = await this.userModel.findById(docid);
    if (!user) throw new NotFoundException('User not found');
    const partyid = await this.UserService.findpartyidbyuserid(user.adminid);

    // Fetch retailer field visibility
    const retailerFields = await this.retailerfieldModel.findOne({ userid: user.userid });
    
    let allowedFields: string[] = [];
    
    if (!retailerFields) {
      retailerProd = await this.productModel.find({ party_id: partyid })
        .select('product_id name sku brand short_description long_description dimensions images category subcategory specification attributes price tally_account video_url updated_at');
    }else{

    let tallyAccounts: string[] = ['all'];
    if (retailerFields && Array.isArray(retailerFields.tally_account)) {
      tallyAccounts = retailerFields.tally_account;
    }

    // Get allowed fields from retailerFields.fields, always include product_id
    allowedFields = Array.isArray(retailerFields?.fields) ? retailerFields.fields.slice() : [];
    if (!allowedFields.includes('product_id')) allowedFields.unshift('product_id');
    if (!allowedFields.includes('video_url')) allowedFields.push('video_url');
    if (!allowedFields.includes('updated_at')) allowedFields.push('updated_at');
    const selectFields = allowedFields.join(' ');

    // If tally_account is 'all', return all products for the party
    if (tallyAccounts.length === 1 && tallyAccounts[0] === 'all') {
      retailerProd = await this.productModel.find({ party_id: partyid })
        .select(selectFields);
    }else{
    // Otherwise, filter products by tally_account
    retailerProd = await this.productModel.find({
        party_id: partyid,
        tally_account: { $in: tallyAccounts }
      }).select(selectFields);
      
    }
  }
  const offers = await this.offerService.getActiveOffersForRetailer(user.userid);
  const retailerproducts = await Promise.all(retailerProd.map(async (product) => {
    const inventory = await this.inventoryModel.findOne({product_id:  product.product_id,});

    // Clean up product fields
    const plainProduct = product.toObject ? product.toObject() : product;
    if (retailerFields) {
      Object.keys(plainProduct).forEach(key => {
        const preserveKeys = ['product_id', 'video_url', 'updated_at', 'images', '_id', '__v'];
        if (!preserveKeys.includes(key) && !allowedFields.includes(key)) {
          delete plainProduct[key];
        }
      });
    }

    // Clean up inventory fields
    let filteredInventory: any = null;
    if (inventory) {
      const plainInv = inventory.toObject ? inventory.toObject() : inventory;
      if (retailerFields) {
        Object.keys(plainInv).forEach(key => {
          const preserveInvKeys = ['product_id', '_id', '__v'];
          if (!preserveInvKeys.includes(key) && !allowedFields.includes(key)) {
            delete plainInv[key];
          }
        });
        // Check if any inventory fields are allowed
        if (allowedFields.includes('quantity') || allowedFields.includes('batch_no') || allowedFields.includes('expiry_date')) {
          filteredInventory = plainInv;
        }
      } else {
        filteredInventory = plainInv;
      }
    }

    // Fetch active pre-orders for this product
    const preOrders = await this.preOrderService.getActivePreOrdersForProduct(product.product_id);
    const totalPreOrderQty = preOrders.reduce((sum, po) => sum + (po.quantity || 0), 0);
    const showQuantity = preOrders.some(po => po.show_quantity);
    const hasPreOrder = preOrders.length > 0;
    const inventoryQty = (filteredInventory && filteredInventory.quantity) ? filteredInventory.quantity : 0;
    const availableQty = Math.max(0, inventoryQty - totalPreOrderQty);

    return {
      product: plainProduct,
      inventory: filteredInventory,
      // Retailer sees: available qty (always reduced), highlight (always if pre-order exists),
      // quantity number ONLY if toggle is ON (showQuantity)
      preOrder: hasPreOrder ? {
        totalQuantity: showQuantity ? totalPreOrderQty : null,
        showQuantity: showQuantity,
        availableQuantity: availableQty,
        hasHighlight: true,
        badgeText: preOrders.find(po => po.badge_text)?.badge_text || 'Trending',
      } : null,
    };
  }));

  return {retailerproducts,
    offers,
  };
  };

  async bulkImportProducts(products: any[], docId: string): Promise<any> {
    const userid = await this.UserService.finduseridbydocumentid(docId);
    const partyid = await this.UserService.findpartyidbyuserid(userid);
    
    const results: any[] = [];
    
    for (const productData of products) {
      try {
        // Generate product ID
        const lastProduct = await this.productModel
          .findOne({ product_id: { $regex: /^PRD\d+$/ } })
          .sort({ product_id: -1 })
          .exec();

        let newProductId = 'PRD100';
        if (lastProduct) {
          const lastId = String(lastProduct.product_id);
          const lastNum = parseInt(lastId.replace('PRD', ''), 10);
          newProductId = `PRD${lastNum + 1}`;
        }

        // Create product
        const newProduct = new this.productModel({
          product_id: newProductId,
          sku: productData.sku,
          name: productData.name,
          long_description: productData.long_description,
          short_description: productData.short_description,
          specification: productData.specification,
          price: parseFloat(productData.price) || 0,
          images: productData.images ? (Array.isArray(productData.images) ? productData.images : (typeof productData.images === 'string' ? productData.images.split(',').map((s: string) => s.trim()) : [])) : (productData.image_url ? productData.image_url.split(',').map((s: string) => s.trim()) : []),
          category: productData.category,
          subcategory: productData.subcategory,
          brand: productData.brand,
          dimensions: {
            length: parseFloat(productData.length) || 0,
            width: parseFloat(productData.width) || 0,
            height: parseFloat(productData.height) || 0,
            weight: parseFloat(productData.weight) || 0
          },
          created_at: new Date(),
          updated_at: new Date(),
          party_id: partyid,
        });

        const savedProduct = await newProduct.save();

        // Create inventory record
        if (productData.initial_quantity) {
          const newInventory = new this.inventoryModel({
            product_id: savedProduct.product_id,
            quantity: parseInt(productData.initial_quantity) || 0,
            batch_no: productData.batch_number || '',
            expiry_date: productData.expiry_date ? new Date(productData.expiry_date) : undefined,
            updated_at: new Date(),
          });
          await newInventory.save();
        }

        results.push({
          success: true,
          product_id: savedProduct.product_id,
          name: savedProduct.name
        });
      } catch (error) {
        results.push({
          success: false,
          name: productData.name,
          error: error.message
        });
      }
    }

    return {
      total: products.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  async updateProduct(productId: string, changes: any): Promise<any> {
    // Separate product and inventory fields
    const inventoryFields = ['quantity', 'batch_no', 'expiry_date'];
    const productChanges: any = { ...changes };
    const inventoryChanges: any = {};
    inventoryFields.forEach(field => {
      if (field in productChanges) {
        inventoryChanges[field] = productChanges[field];
        delete productChanges[field];
      }
    });
    // Ensure price is a number if present
    if ('price' in productChanges && typeof productChanges.price === 'string') {
      productChanges.price = parseFloat(productChanges.price);
    }
    // Update product
    const updatedProduct = Object.keys(productChanges).length > 0
      ? await this.productModel.findOneAndUpdate(
          { product_id: productId },
          { $set: productChanges },
          { new: true }
        )
      : await this.productModel.findOne({ product_id: productId });
    // Update inventory if needed
    let updatedInventory = null;
    if (Object.keys(inventoryChanges).length > 0) {
      updatedInventory = await this.inventoryModel.findOneAndUpdate(
        { product_id: productId },
        { $set: inventoryChanges },
        { new: true }
      );
    }
    return { product: updatedProduct, inventory: updatedInventory };
  }

  async getProductById(productId: string): Promise<Product> {
  const product = await this.productModel.findOne({ product_id: productId });
  if (!product) {
    throw new NotFoundException('Product not found');
  }
  return product;
 }
async deleteProduct(productId: string): Promise<any> {
  // Delete the product
  const deletedProduct = await this.productModel.findOneAndDelete({ 
    product_id: productId 
  });

  if (!deletedProduct) {
    throw new NotFoundException(`Product with ID ${productId} not found`);
  }

  // Also delete associated inventory
  await this.inventoryModel.deleteMany({ product_id: productId });

  // Also delete associated offers if they exist
  try {
    await this.offerService.deleteOffersByProductId?.(productId);
  } catch (error) {
    console.warn('Could not delete associated offers:', error);
  }

  // Also delete associated pre-orders if they exist
  try {
    await this.preOrderService.deletePreOrdersByProductId(productId);
  } catch (error) {
    console.warn('Could not delete associated pre-orders:', error);
  }

  return {
    message: 'Product deleted successfully',
    product_id: productId
  };
}
}
