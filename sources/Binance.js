const FeedSource =require('./FeedSource.js');
const request = require('request-promise-native');

class Binance extends FeedSource {
	constructor(config) {
		super(config);
		this.init();
	}
	init() {

	}
	async _fetch() {
		var feed={};
		var self=this;

		for (var bindex=0;bindex<self.options.bases.length;bindex++) {
			let base=self.options.bases[bindex];

			feed[base]={};

			for (var qindex=0;qindex<self.options.quotes.length;qindex++) {
				let quote=self.options.quotes[qindex];

				if (quote==base) {
					continue;
				}
				var url = 'https://www.binance.com/api/v1/ticker/24hr?symbol='+quote.toUpperCase()+base.toUpperCase();
				var result= await request(url);
				result=JSON.parse(result);
				if((self.options.quoteNames!=undefined) && (self.options.quoteNames[quote]!=undefined)) {
					quote=self.options.quoteNames[quote];
				}
				feed[base][quote]= {
					'price': result['lastPrice'],
					'volume': result['volume']*self.options.scaleVolumeBy
				};
			}
		}

		return feed;
	}
}
module.exports=Binance;