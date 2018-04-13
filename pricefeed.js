const {Apis} = require("bitsharesjs-ws");
const math = require('mathjs');
const util = require('util');

function weightedAvg(arrValues, arrWeights) {

    var result = arrValues.map(function (value, i) {
  
      var weight = arrWeights[i];
      var sum = value * weight;
  
      return [sum, weight];
    }).reduce(function (p, c) {
  
      return [p[0] + c[0], p[1] + c[1]];
    }, [0, 0]);
  
    return result[0] / result[1];
}
function weightedStd(arrValues, arrWeights) {

    var average= weightedAvg(arrValues, arrWeights);
    var variance=weightedAvg(arrValues.map(x=>{ return Math.pow((x-average),2);}),arrWeights);
    return Math.sqrt(variance);
}
class Feed {
    constructor(config) {
        this.config=config;
        this.Api={};
        this.feed={};
        this.price={};
        this.volume={};
        this.price_result={};
        this.reset();
        
    }
    async init() {
        return this.getProducer();
    }
    reset() {
        this.data={}
        for (var base in this.config.assets) {
            this.data[base]={};
            for(var quote in this.config.assets) {
                this.data[base][quote]=[];
            }
        }
    }
    async getProducer() {
       this.producer=await Apis.instance("wss://bitshares.openledger.info/ws", true).init_promise.then((res) => {
           this.Api=Apis.instance();
            this.Api.db_api().exec( "get_account_by_name", [this.config.producer] );
        });
        return this.producer;
    }
    get_my_current_feed(asset) {
        var feeds=asset.feeds;
        for (var feed in feeds) {
            if(feeds[feed]['producer']['id']=this.producer['id']) {
                return feeds[feed];
            }
        }
    }
    async obtain_price_change(symbol) {
        var asset=await this.Api.db_api().exec( "lookup_asset_symbols", [[symbol]] ).then((res)=>{
            let asset=res[0];                        
            return this.Api.db_api().exec( "get_objects", [[asset.id]] );            
        }).then((assetstats)=> {
            return assetstats[0];
        }); 
        if (asset['is_bitasset']==false) {
            return;
        }
        asset['bitasset_data']=await this.Api.db_api().exec( "get_objects", [[asset['bitasset_data_id']]] ).then((res) => { return res[0]; });
        var price=this.price_result[symbol];
        var newPrice=price['price'];
        var current_feed=this.get_my_current_feed(asset);
        var oldPrice;
        if ((current_feed!=undefined) && (current_feed['settlement_price']!=undefined)) {
            oldPrice=current_feed['settlement_price'];
        }else{
            oldPrice=Infinity;
        }
        
        this.price_result[symbol]['priceChange'] = (oldPrice - newPrice) / newPrice * 100.0;
        this.price_result[symbol]['current_feed'] = current_feed;
        this.price_result[symbol]['global_feed'] = asset['bitasset_data']['current_feed'];
        return;
    }
    obtain_flags(symbol) {
        this.price_result[symbol].flags=[];
        
        if (Math.abs(this.price_result[symbol]["priceChange"]) > Math.abs(this.assetconf(symbol, "min_change"))) {
            this.price_result[symbol]["flags"].push('min_change');
        }
        if (Math.abs(this.price_result[symbol]["priceChange"]) > Math.abs(this.assetconf(symbol, "warn_change"))) {
            this.price_result[symbol]["flags"].push('over_warn_change');
        }
        if (Math.abs(this.price_result[symbol]["priceChange"]) > Math.abs(this.assetconf(symbol, "skip_change"))) {
            this.price_result[symbol]["flags"].push("skip_change");
        }
        var feed_age;
        if (this.price_result[symbol]["current_feed"]!=undefined){
            feed_age = Date.parse(this.price_result[symbol]["current_feed"]["date"]);
        } else {
            feed_age=0;
        }
        if (((new Date()).getTime() - feed_age) > this.assetconf(symbol, "maxage")) {
            this.price_result[symbol]["flags"].push("over_max_age");
        }
        console.log('done');
    }
    async get_cer(symbol,price) {
        
        if ((this.config['assets'][symbol]!=undefined) && (this.config['assets'][symbol]['core_exchange_factor']!=undefined)) {
            return price * this.assetconf(symbol,'core_exchange_factor');
        }
        if ((this.config['assets'][symbol]!=undefined) && (this.config['assets'][symbol]['core_exchange_rate']!=undefined)) {
            cer = this.config["assets"][symbol]["core_exchange_rate"]
            if ((cer['orientation']==undefined) || (cer['factor']==undefined) || (cer['ref_ticker']==undefined)) {
                throw('Missing one of required settings for cer: {}');
            }
            
            // TODO: Deal with CER cases that require deeper understanding of PyBitshares class instantiation and operator overloading
            process.exit(1);
            //var tick=cer["ref_ticker"].split('/').split(':');
            //ticker = await   this.Api.db_api().exec( "get_ticker", [tick[0],tick[1]] );
            //price = ticker[cer["ref_ticker_attribute"]];
            //price. *= cer["factor"]
            //orientation = Market(cer["orientation"])
            //return price.as_quote(orientation["quote"]["symbol"])
        }
    }
    async fetch() {
        if ((this.config['exchanges']==undefined)  || (this.config['exchanges'].length==0)) {
            return;
        }
         
        for (var exchange in this.config.exchanges) {
            if (this.config.exchanges[exchange].enable) {
                var instance=new (require('./sources/'+this.config.exchanges[exchange].klass))(this.config.exchanges[exchange]);
                var afeed=await instance.fetch();
                this.feed[exchange]=afeed;
            }
        }   
    }
    assethasconf(symbol,parameter) {
        if ((this.config.assets[symbol]!=undefined) && (this.config.assets[symbol][parameter]!=undefined)) {
            return true;
        }else{
            return false;
        }
    }
    assetconf(symbol,parameter,no_fail) {
        if ((this.config.assets[symbol]!=undefined) && (this.config.assets[symbol][parameter]!=undefined)) {
            return this.config.assets[symbol][parameter];
        }else{
            if ((this.config['default']!=undefined) && (this.config['default'][parameter]!=undefined)) {
                return this.config['default'][parameter];
            }else{
                if (no_fail) {
                    return;
                }else{
                    throw(parameter+' for '+symbol+' not defined!');
                }
            }
        }
    }
    addPrice(base,quote,price,volume,sources) {
        if (this.data[base]==undefined) {
            this.data[base]={};
        }
        if (this.data[base][quote]==undefined) {
            this.data[base][quote]={};
        }
        var flat_list=[];
        for (var i=0;i<sources.length;i++) {
            var source=sources[i];
            if (Array,isArray(source)) {
                for (var j=0;j<source.length;j++) {
                    flat_list.push(source[j]);
                }
            }else{
                flat_list.push(source);
            }
        }
        this.data[base][quote].push({
                "price": price,
                "volume": volume,
                "sources":flat_list
        });
    }
    appendOriginalPrices(symbol) {
        if (this.config['exchanges']==undefined) {
            return;
        }
        for (var datasource in this.assetconf(symbol,'sources')) {
            
            if (this.config['exchanges'][datasource].enable==false) {
                continue;
            }
            if (this.feed[datasource]==undefined) {
                continue;
            }
            for (var base in this.feed[datasource]) {
                if (base=='response') {
                    continue;
                }
                for (var quote in this.feed[datasource][base]) {
                    if (quote=='response') {
                        continue;
                    }
                    if ((base==undefined) || (quote==undefined)) {
                        continue;
                    }
                    if (this.feed[datasource][base][quote]['volume']==0) {
                        continue;
                    }
                    var sources=[];
                    sources.push(datasource);
                    this.addPrice(base,quote,this.feed[datasource][base][quote]['price'],this.feed[datasource][base][quote]['volume'],sources);
                    if ((this.feed[datasource][base][quote]['price']>0) && (this.feed[datasource][base][quote]['volume'] > 0)) {
                        this.addPrice(quote,base,1.0/this.feed[datasource][base][quote]['price'],this.feed[datasource][base][quote]['volume']*this.feed[datasource][base][quote]['price'],sources);
                    }
                }
            }
        }
    }
    derive2Markets(asset,target_symbol) {
        var symbol=asset['symbol'];
        for (var interasset in this.config['intermediate_assets']) {
            if (interasset==symbol) {
                continue;
            }
            for (var ratio in (this.data[symbol][interasset]))  {
                if ((this.data[interasset]!=undefined) && (this.data[interasset][target_symbol]!=undefined)) {
                    for (var idx=0; idx<this.data[interasset][target_symbol].length;idx++) {
                        if (this.data[interasset][target_symbol][idx]['volume']==0) {
                            continue;
                        }
                        var sources=this.data[interasset][target_symbol][idx]['sources'].concat(ratio['sources']);
                        this.addPrice(symbol,target_symbol,this.data[interasset][target_symbol][idx]['price']*ratio['price'],this.data[interasset][target_symbol][idx]['price']*ratio['price'],sources);
                    }
                }
            }
        }
    }
    get_prices() {
        return this.price_result;
    }
    derive3Markets(asset,target_symbol) {
        //todo
    }
    async derive(assets_derive) {
       
        
        if (assets_derive.length==0) {
            assets_derive = this.config["assets"];
        }

        this.price_result = {}
        for (var symbol in assets_derive) {
            this.price_result[symbol] = {}
        }

        
        for (var symbol in assets_derive) {
            this.type_extern(symbol);
        }
        for (var symbol in assets_derive) {
            //TODO :type_intern not implemented;
           // this.type_intern(symbol);
        }
        
        for (var symbol in assets_derive) {
            if (this.price_result[symbol]==undefined) {                
                continue;
            }
            
           await  this.obtain_price_change(symbol)
            await this.obtain_flags(symbol)
        }
        console.log(util.inspect(this.price_result,true,null));
        return this.price_result

    }
    async type_extern(symbol) {
    
        var asset=await this.Api.db_api().exec( "lookup_asset_symbols", [[symbol]] ).then((res)=>{
            let asset=res[0];                        
            return this.Api.db_api().exec( "get_objects", [[asset.id]] );            
        }).then((assetstats)=> {
            return assetstats[0];
        }); 
        if (asset['is_bitasset']==false) {
            return;
        }
        asset['bitasset_data']=await this.Api.db_api().exec( "get_objects", [[asset['bitasset_data_id']]] ).then((res) => { return res[0]; });
        //console.log(asset);
        var short_backing_asset = await this.Api.db_api().exec( "lookup_asset_symbols", [[asset["bitasset_data"]["options"]["short_backing_asset"]]] ).then((res)=>{
            let asset=res[0];                        
            return this.Api.db_api().exec( "get_objects", [[asset.id]] );            
        }).then((assetstats)=> {
            return assetstats[0];
        }); 
        var backing_symbol = short_backing_asset["symbol"];
        asset["short_backing_asset"] = short_backing_asset;

        if ((this.assetconf(symbol, "type")!='extern') ||  (this.assetconf(symbol, "type")!='alias')) {
            return;
        }
        var alias;
        if (this.assetconf(symbol, "type") == "alias") {
            alias = this.assetconf(symbol, "alias");
            asset = await this.Api.db_api().exec( "lookup_asset_symbols", [[alias]] ).then((res)=>{
                let asset=res[0];                        
                return this.Api.db_api().exec( "get_objects", [[asset.id]] );            
            }).then((assetstats)=> {
                return assetstats[0];
            }); 
        }else{
            alias = symbol;
        }

    
        this.reset()

        
        this.appendOriginalPrices(symbol)
        this.derive2Markets(asset, backing_symbol)
        //TODO 3 Markets not implemented yet
        //this.derive3Markets(asset, backing_symbol)

        if (this.data[alias]==undefined) {
            console.log("'"+alias+"' not in this.data");
            return;
        }
        if (this.data[alias][backing_symbol]==undefined) {    
            console.log("backing symbol '"+backing_symbol+"' not in this.data['"+alias+"']");        
            return;
        }
        var assetvolume=[];
        var assetprice=[];
        for (var v in this.data[alias][backing_symbol]) {
            assetvolume.push(this.data[alias][backing_symbol][v]['volume']);
            assetprice.push(this.data[alias][backing_symbol][v]['price']);
        }

        if (assetvolume.length > 1) {
            price_median = math.median(assetprice);
            price_mean = math.mean(assetprice);
            price_weighted = weightedAvg(assetprice, assetvolume);
            price_std = weightedStd(assetprice, assetvolume);
        }else if (assetvolume.length == 1) {
            price_median = assetprice[0];
            price_mean = assetprice[0];
            price_weighted = assetprice[0];
            price_std = 0;
        }else{
            console.log("[Warning] No market route found for "+symbol+". Skipping price");
            return;
        }

        metric = this.assetconf(symbol, "metric")
        if (metric == "median") {
            p = price_median;
        }else if (metric == "mean") {
            p = price_mean;
        }else if(metric == "weighted") {
            p = price_weighted;
        }else {
            throw("Asset "+symbol+" has an unknown metric '"+metric+"'");
        }

        var cer = this.get_cer(symbol, p)

        
        this.price_result[symbol] = {
            "price": p,
            "cer": cer,
            "mean": price_mean,
            "median": price_median,
            "weighted": price_weighted,
            "std": price_std * 100,  
            "number": assetprice.length,
            "short_backing_symbol": backing_symbol,
            "mssr": this.assetconf(symbol, "maximum_short_squeeze_ratio"),
            "mcr": this.assetconf(symbol, "maintenance_collateral_ratio"),
            "log": this.data
        }
    }
}

module.exports=Feed;