'use strict';

String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	/**
	 * Initialize the Leitner environment by initializing the database, and loading all 
	 * card decks. 
	 *
	 * Returns a defer promise (?) that concluded when the environment is properly loaded.
	 */
	init : async function() 
	{

		// - init database
		lt.db = new Dexie('leitner')
		
		lt.db.version(1).stores({
              events: 'id++, timestamp, deck, card, alt1, alt2, correct, [deck+card], [deck+card+correct]'
        });
		
		// - load all decks
		let rqs = []; 
		for (let pair of lt.deck_files)
		{
			let df, order;
			[df, order] = pair
			
			let prm = $.getJSON(df).then(async function(deck) {await lt.loadDeck(deck, order);});
			rqs.push(prm);
		}
		
		await Promise.all(rqs)
				
		for (let [name, deck] of Object.entries(lt.decks)) 
			lt.sortedDecks.push(deck);
			
		lt.sortedDecks.sort((a, b) => a.order > b.order ? 1 : -1); 
	
	},
	
	// Add new decks here
	deck_files : [
		['../decks/hanzi01.json', 0],
		['../decks/capitals.json', 1],
		['../decks/countries.json', 2],
		['../decks/esperanto01.json', 3],
		['../decks/us-states.json', 4],				
		['../decks/hanzi02.json', 5],
		['../decks/flags.json', 6],
		['../decks/morse.json', 7]
	],
	
	/**
	 * Default number of cards per session (equals about 7 minutes for the average deck)
	 *
	 */
	defaultLimit : 100,
	
	// TODO: automate this in init(). Use a query to collect all script elements with type="text/x-jsrender"
	templates : { 
		mc: $.templates("#mc"), 
		text: $.templates("#text"), 
		decklink: $.templates("#decklink") 
	},
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	/**
	 * Decks indexed by name.
	 *
	 */
	decks : {},

	/**
	 * Decks sorted by user-specified order.
	 *
	 * This order determines in which order the training progresses.
	 */
	sortedDecks : [],
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : async function(deck, order) 
	{
		if (!( 'id' in deck))
			deck.id = (deck.name + '').hash()
			
		deck.order = order	
			
		deck.cards.forEach((card) => 
		{		
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
			{
				let sumstr = deck.id  + ': ';
				for (var side of card.sides)
					sumstr += side + ', ';
					
				card.id = sumstr.hash()		
			}
		});
		
		lt.decks[deck.name] = deck
		
		console.log(deck.name + ' loaded.');
		
		await lt.computeScores(deck);
		
		console.log(deck.name + ' scores computed.');
		
		// Default order is by ID
		deck.cards = _.sortBy(deck.cards, [function(card){return card.id; }])
		
		// TODO: 
		//  validate that nr. of sides for each card is the same as deck.sides.length
		//  set default if key 'typing-sides' is missing.
		//  check max(typableSides)
		
		// * Map from card id to its index in the deck.cards array
		deck.id2idx = new Map()
		deck.cards.forEach((card, idx) => {
			deck.id2idx.set(card.id, idx)
		});
		
		// * Create a dictionary mapping any side to its card
		let s2c = new Map()
		for (let card of deck.cards)
			for (let side of card.sides)
				s2c.set(side, card)
	
			
		// * Create a graph of similar cards (i.e. ones that are easily mistaken for each 
		//   other.
		// -- For now, we only use user hints.
		deck.sim = new Map()
		if (deck.hasOwnProperty('similar'))
			for (let coll of deck.similar)
				for (let first of coll)
					for (let second of coll)
						if (first !== second)
						{	
							let c1 = s2c.get(first), c2 = s2c.get(second);
							if (c1 == undefined)
								throw `Error parsing similarity array: could not find card with side "${first}"`;
							if (c2 == undefined)
								throw `Error parsing similarity array: could not find card with side "${second}"`;
							
							let c1idx = deck.id2idx.get(c1.id), c2idx = deck.id2idx.get(c2.id);
							
							if (! deck.sim.has(c1idx))
								deck.sim.set(c1idx, []);
								
							deck.sim.get(c1idx).push(c2idx);
						}
		
		console.log(deck.sim)
		// TODO: Get statistics from events DB. Use transitive property for sampling?
		
		// NOTE: Don't do this on the fly. Add an "analysis" button to each deck that 
		//       computes suggestions based on Levenshtein distance and events in db. 
		//       Let users copy and edit these suggestions into the deck. 
	},
	
	mask : function(text, prop) 
	{
		let num = Math.floor(text.length * prop)
		let idxs = new Set(_.sampleSize(_.range(text.length), num)) // indices to be masked out
		
		let res = ''
		for (let i of _.range(text.length))
		{
			if (idxs.has(i) && text.charAt(i) !== ' ')
				res += '*';
			else
				res += text.charAt(i);
		}
		
		return res
	},
	
	/**
	 * Computes Levenshtein distance. From https://gist.github.com/andrei-m/982927
	 *
	 * For this function:
     *	 Copyright (c) 2011 Andrei Mackenzie
	 *	 Permission is hereby granted, free of charge, to any person obtaining a copy of 
	 *   this software and associated documentation files (the "Software"), to deal in the 
	 *   Software without restriction, including without limitation the rights to use, 
	 *   copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
	 *   Software, and to permit persons to whom the Software is furnished to do so, subject
	 *   to the following conditions: The above copyright notice and this permission 
	 *   notice shall be included in all copies or substantial portions of the Software.
	 *	 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR 
	 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
	 *   FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR 
	 *   COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN 
	 *   AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION 
	 *   WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
	 */
	levDistance : function(a, b)
	{
	
		  if(a.length == 0) return b.length; 
		  if(b.length == 0) return a.length; 

		  var matrix = [];

		  // increment along the first column of each row
		  var i;
		  for(i = 0; i <= b.length; i++)
		  {
			matrix[i] = [i];
		  }

		  // increment each column in the first row
		  var j;
		  for(j = 0; j <= a.length; j++)
		  {
			matrix[0][j] = j;
		  }

		  // Fill in the rest of the matrix
		  for(i = 1; i <= b.length; i++)
		  {
			for(j = 1; j <= a.length; j++)
			{
			  if(b.charAt(i-1) == a.charAt(j-1))
			  {
				matrix[i][j] = matrix[i-1][j-1];
			  } else 
			  {
				matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, // substitution
									Math.min(matrix[i][j-1] + 1, // insertion
										matrix[i-1][j] + 1)); // deletion
			  }
			}
		  }

		  return matrix[b.length][a.length];
	},
	
	
	/**
	 * Scoring based on an approximation of the Leitner system. 
	 *
	 * We look at the most recent sequence of fails and successes. Let k be the length of 
	 * contiguous successes since the most recent failure. k determines the "pile" the card
	 * is in. Cards in pile k are shown with probability around 1 - 2^-k (exact formula in development).
	 * 
	 * We then modify this score with a multiplier, based on the number of days that have 
	 * passed since the card was last seen. We assume, for now that the probability of 
	 * remembering a card decays uniformly by .95 per day. 
	 *
	 */
	computeScores : async function(deck)
	{
		// * How much each sequential correct answer decays the probability of a an incorrect one.
		let base = 0.15;
		// -- The closer to zero, the more quickly the engine moves on to new cards.
		
		// * How many milliseconds in a day.
		let msPerDay = 8.64e+7;
		// * How much each day decays the probability of giving a correct answer.
		let decayRate = 0.95
		
		let min = Number.POSITIVE_INFINITY
		deck.numOver99 = 0
	
		for (let card of deck.cards) 
		{
			
			await lt.db.events // latest seen
 				.where('[deck+card]').equals([deck.id,card.id]).reverse().sortBy('timestamp')
 				.then(function(events)
 				{
 					// Compute length of most recent contiguous sequence of successes
 					let k = 0
 					for (event of events)
 						if (event.correct)
 							k ++;
 						else
 							break;
 					
 					let baseScore = 1.0 - Math.pow(base, k)
 					
 					// Compute time since seen modifier
 					let msSinceSeen = events.length > 0 ? Date.now() - events[0].timestamp : 28 * 365;
 					let daysSinceSeen = msSinceSeen / msPerDay;
 					
 					let decayBase = 1.0 - (1.0/(k+1));
 					// -- The more consecutive corrects we have, the slower the score decays
 					let decayOffset = k
 					// -- If we have k consecutive corrects, the score starts decaying after k days.

 					let decay = Math.pow(decayBase, Math.max(0, daysSinceSeen - k))
 					
 					card.score = baseScore * decay
 					
 					// for debugging
 					card.k = k
 					card.baseScore = baseScore
 					card.decay = decay
 					card.daysSinceSeen = daysSinceSeen
 					
 					deck.minScore = Math.min(min, card.score)
 					if (card.score> 0.99)
 						deck.numOver99 += 1;
 				});
 		}
	
	},
	
	/**
	 * Convert the raw text of a card to (potentially) HTML content
	 */
	content : function(rawText)
	{
		if (rawText.startsWith('img:'))
			return $('<img>').attr('src', rawText.substring(4)).prop('outerHTML');
			
		return rawText
	},
	
	createProgress : function(deck, targetIdx, target, tight = false)
	{
	
		if (target == undefined)
			target = 'div.progress';
			
		const parent = d3.select(target)

		let width = parent.node().getBoundingClientRect().width * (tight ? 1.0 : 0.9)
	
		let eps = 1e-5
		let scores = deck.cards.map((card) => card.score);
		let pix = Math.min(width / scores.length, 10)
		
		let minHeight = 10;
		
		const svg = parent.append('svg')
		
		svg.attr('width', width) // pix * scores.length)
		   .attr('height', Math.max(tight ? 2*pix : pix, minHeight) )
// 			   .attr("style", "outline: thin solid red;")
			
		let xCoord = function(i) {return i == targetIdx ? i * pix - (pix/2) : i * pix};
		let yCoord = function(i) {return i == targetIdx ? 0 : pix/2};
		
		const prog = svg.selectAll("g")
			.data(scores)
			.join("g")
				.attr("transform", (d, i) => `translate(${xCoord(i)}, ${yCoord(i)})`);
				
		var colorScale = d3.scaleSequential(d3.interpolateRdYlGn)
			.domain([1, -8.5])
								
		prog.append("rect")
			.attr("fill", "steelblue")
			.attr("width", (score, i) => {return i == targetIdx ? 2*pix : pix})
			.attr("height", (score, i) => {return Math.max((i == targetIdx ? 2*pix : pix), minHeight)})
			.attr('fill', (score, i) => {return colorScale(Math.log(1.0 - score + eps));})

		// TODO: would be nicer to update this rather than redraw every time									
			
	}, 	
	
	/** 
	 * Sub-namespace for the current session
	 *
	 */
	session : {
	
		startSession : async function(deck)
		{

			lt.session.deck = deck
			
			lt.session.recent = []
			
			let params = new URLSearchParams(window.location.search);
			if (params.has('limit'))
				lt.session.limit = parseInt(params.get('limit'))
						
			$('nav #train').addClass('hidden')
			$('nav #session-info').removeClass('hidden')
			
			await lt.session.preload();
			
			lt.session.generate();

		},
		
		imageCache : [], 
		// -- The cache is just used to keep the images from being garbage collected
		//    The browser should take care of the caching itself.
		
		/**
		 * Preload any image references in the deck.
		 */
		preload : async function(deck)
		{
			
			for (let card of lt.session.deck.cards)
				for (let side of card.sides)
					if (side.startsWith('img:'))
					{
						let url = side.substring(4)

						let res = document.createElement("link");
						res.rel = 'preload';
						res.as = 'image';
						res.href = url;
						
						document.head.appendChild(res);
					}
					
			console.log(`Images preloaded for deck ${lt.session.deck.name}`)
		},
		
		/**
		 * Session target (number of questions)
		 *
		 */
		limit: undefined,
		
		/**
		 * Number of cards seen
		 *
		 */
		seen: 0, 
		
		/**
		 * Buffer of recently seen cards (to be rejected from sampling)
		 */
		recent : [], 
		recentMax : 5,
		
		/**
		 * Sample a card from the deck according to the scores, using the pivot strategy. 
		 *
		 * The strategy is to sample cards whose probability of being answered correctly 
		 * is close to 0.5. Doing this repeatedly eventually pushes all probabilities up 
		 * to 1.0
		 *
		 * NB: Re-orders the cards
		 */
		samplePivot : function()
		{
			let deck = lt.session.deck
		
			// Sort by score
			_.sortBy(deck.cards, [function(card){return card.score; }])
			
			// Find the card whose probability is closest to 0.5
			let pivot;
			let smallestDistance = Number.POSITIVE_INFINITY;
			
			deck.cards.forEach((card, i) =>
			{
				let distance = Math.abs(card.score - 0.5);				
				if (distance < smallestDistance)
				{
					pivot = i;
					smallestDistance = distance;
				}
			});
			
			
			// Sample around that card
			let target = pivot + _.sample([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
			target = _.clamp(target, 0, deck.cards.length);
						
						
			console.log('pivot score', deck.cards[target].score)
						
			return deck.cards[target]
		},
		
		
	 	/**
		 * Sample a card from the deck according to the scores, using the sequential strategy.
		 *
		 * The strategy is to keep the cards sorted, and to move from left to right. Then 
		 * at point, we sample that particular card with the probability that it will be 
		 * answered incorrectly.
		 * 
		 * NB: Assumes that the cards maintain a fixed order.
		 */
		sampleSeq : function()
		{
			let res = null;
			let deck = lt.session.deck;

			for (let trial of _.range(100)) // allow 100 rejections
			{
				for (let card of deck.cards)
				{
					let r = _.random(0,1,true);
					if (r > card.score)
					{
						res = card;	
						break;
					}
				}
				
				if (res != null && lt.session.recent.indexOf(res.id) == -1)
					break;
// 				else
// 					console.log('Rejected sample: ', res.id);
			}
				
			
			if (res == null) // Clever approach failed. Sample uniformly.
			{
				console.log('Could not sample by scores. Sampling uniformly.')
				res = _.sample(deck.cards);
			}
			
			lt.session.recent.push(res.id)
			while(lt.session.recent.length > lt.session.recentMax) 
				lt.session.recent.shift()
			//--  dequeue until buffer is at max size
			
			console.log(res.sides[0])
			console.log('consecutive corrects', res.k);
			console.log('score', res.score);
			console.log('basescore', res.baseScore);
			console.log('decay', res.decay);
			console.log('daysSinceSeen', res.daysSinceSeen);
			
			return res
			
		},
	
		mcProb : 0.5,
	
		generate : function() 
		{
			if (lt.session != undefined && lt.session.seen >= lt.session.limit)
			{
				window.location.replace('/')
				return;
			}
			
			if (lt.session.limit == undefined)
				$('#session-info').html(`seen this session: ${lt.session.seen}`)
			else 
				$('#session-info').html(`to go: ${lt.session.limit - lt.session.seen}`)
		
			let deck = lt.session.deck;
			let card = lt.session.sampleSeq(); // Draw a card
			
			let hasSim = deck.sim.has(deck.id2idx.get(card.id)); 
			// -- Check if we have similarity hints for this card
			
			// * If so, with some probability we switch the sample to one of its similars.
			if (hasSim)
			{
				let sims = deck.sim.get(deck.id2idx.get(card.id));
				let switchProb = 1.0 - (1.0/(sims.length + 1))
				// -- The probability of switching is so that each alternative (including 
				//    our sampled card) has the same probability.
				if (_.random(0, 1, true) < switchProb)
				{						
					let simCards = sims.map((idx) => {return deck.cards[idx]});
					card = _.sample(simCards);
				}
			}
			// -- The idea here is that if a card with similars drops to a low score, you 
			//    can still pick it out form its similars, since that's always the card 
			//    you've been seeing recently. By switching a sampled card to 
			//    its similars we prevent this tactic, without needing to augment the score
			//    for the similars.
			
			let score = card.score != undefined ? card.score : 0.0;
			
			let mcThreshold = hasSim ? 0.5 : 0.05;
			// -- If we have similarity hints for this card, keep the MC probability high.
			//    Otherwise, favor the typing exercises as the score gets higher.
		
			if (_.random(0, 1, true) < Math.max(mcThreshold, 1.0 - score) || lt.session.deck.typableSides.length == 0) 
				lt.session.generateMC(card);
			else
				lt.session.generateText(card);
				
				
			// -- MC questions are drawn with probability inversely proportional to the 
			//    score, unless that probability drops below a given threshold
				
			lt.session.seen ++;
		},
		
		/**
		 * Generate a text field question. One of the sides of the card is shown, and the 
		 * user is asked to type in the content of one of the other sides.
		 *
		 */
		generateText : function(card)
		{
			let deck = lt.session.deck

			let back  = _.sample(deck.typableSides);
			let front = _.sample(
				_.without(
					_.range(deck.sides.length),
					back
				)
			);
			
			console.log('front', front, 'back', back, deck.sides)

			$("article").empty();
			
			let question = card.sides[front];
			let answer   = card.sides[back];			

			$("article").html(
				lt.templates.text.render({
					frontname: deck.sides[front],
					backname: deck.sides[back],
					question: lt.content(question),
				})
			);
			
			$(".frame #answer").focus()
			
			lt.createProgress(deck, deck.cards.indexOf(card));
			
			if (question.startsWith('img:'))
				$('.frame .question').addClass('image')
			else if (question.length < 4)
				$('.frame .question').addClass('short')
			else if (question.length < 10)
				$('.frame .question').addClass('medium')
				
			$('.frame .question').addClass('side-'+front);
			$('.frame form').addClass('side-'+back); 
			
			$("article form").on(
				'submit',
				{ 
					timestamp: Date.now(),
					deck: deck.id,
					card: card.id,
					question: question,
					front: front,
					back: back,			  
					allSides: card.sides,    
					correctAnswer: answer,
				},
				lt.session.processTextAnswer
			)
		},		
		
		/**
		 * Allowed edit distance between answer and truth, as a proportion of the length 
		 * of the answer
		 */
		distAllowed: 0.3,
		
		/**
		 * Check if a given answer is close enough to the correct answer to count as correct
		 * 
		 */
		checkText : function(correct, answered)
		{
		
			// - Remove any content in square brackets
			correct = correct.replace(/ *\[[^)]*\] */g, "");			
			answered = answered.replace(/ *\[[^)]*\] */g, "");		
		
			// - Trim, normalize accents, cases
			correct = correct.toLowerCase().trim();
			answered = answered.toLowerCase().trim();
			
			// - Normalize diacritics
			correct = correct.normalize("NFD").replace(/\p{Diacritic}/gu, "");
			answered = answered.normalize("NFD").replace(/\p{Diacritic}/gu, "");
			
			let distance = lt.levDistance(correct, answered);
		
			return distance < lt.session.distAllowed * correct.length;
		},
						
		processTextAnswer : function(e)
		{	
			let edata = e.data; // -- this is apparently required to stop some race conditions from JS re-using its event objects

			e.preventDefault(); // Stop the default form submit action.
				    		    
			let etarget = e.target;
		
			let answered = $('article .frame #answer').val()
			let correct = edata.correctAnswer
			
			let success = lt.session.checkText(correct, answered)
			
			console.log(answered, correct, edata)
			
			// -- Check whether user typed wrong side
			let wrongSide = false, sideAnswered = -1;
			if (! success) 
			{
				edata.allSides.forEach((side, i) => {
					if (i != edata.front && i != edata.back)
						if(lt.session.checkText(side, answered))
						{
							wrongSide = true;
							sideAnswered = i;
						}
				});			
			}

			if (! wrongSide) 
			{
				let newRow = 
				{
					timestamp: edata.timestamp,
					deck: edata.deck,
					card: edata.card,
					answered: answered,
					front: edata.front,
					back: edata.back,
					correct: success ? 1 : 0,
					questionType: 'text',
				}
			
				lt.db.events.add(newRow).then (result =>
				{
					console.log(newRow);
				}).catch('ConstraintError', er => 
				{
					console.error ("Constraint error: " + er.message);
					console.error(newrow);
				});

				lt.computeScores(lt.session.deck)
			}

			if(success)
			{
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.sounds.incorrect.play()

			
				if (wrongSide) // typed wrong side
				{
					setTimeout(function(){$('article .frame #answer').val('');}, 500);

					let hint = $('article .frame #hint');
				
					hint.empty();
					hint.removeClass('hidden');
					hint.addClass('visible');

					console.log(0);
					hint.append('Wrong side. Type the '+lt.session.deck.sides[edata.back]+' answer.');
					setTimeout(function(){hint.toggleClass('visible hidden');}, 1500);
					
				} else {
			

					setTimeout(function(){$('article .frame #answer').val('');}, 500);

					let hint = $('article .frame #hint');
				
					let wrongs = parseInt(hint.attr('data-wrong'))
					console.log(wrongs, ' incorrect answers.')
					hint.attr('data-wrong', wrongs + 1)
				
					hint.empty();
					hint.removeClass('hidden');
					hint.addClass('visible');

					if (wrongs == 0)		
					{	
						console.log(0);
						hint.append(lt.mask(correct, 0.95));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
				
					} else if (wrongs == 1)
					{	
						console.log(1);
						hint.append(lt.mask(correct, 0.5));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
					} else if (wrongs == 2)
					{
						console.log(2);
						hint.append(lt.mask(correct, 0.25));
						setTimeout(function(){hint.toggleClass('visible hidden');}, 100);
					} else 
					{	
						hint.append(correct);
					}
				}
			}
			
		},
		
		/**
		 * Generate a multiple-choice question. One of the sides of the card is shown, and 
		 * the user is asked to choose the correct value of another side out of three 
		 * options.
		 *
		 */
		generateMC : function(sampleTarget)
		{
			let deck = lt.session.deck
			
			
			let back  = _.sample(_.range(deck.sides.length));
			let front = _.sample(
				_.without(
					_.range(deck.sides.length),
					back
				)
			);
			
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			
// 			let sampleAlt = _.sampleSize(_.without(deck.cards, sampleTarget), 2)

			let sampleAlt = lt.session.sampleAlt(sampleTarget, deck)
			console.assert(sampleAlt.length == 2)
			
			let sample = [sampleTarget].concat(sampleAlt)
						
			let ord = _.shuffle([0, 1, 2]); // -- random order of the answers
			let correct = ord[0]
			
			let answers = [undefined, undefined, undefined]
			answers[ord[0]] = sample[0]
			answers[ord[1]] = sample[1]			
			answers[ord[2]] = sample[2]

			let q = sampleTarget.sides[front];

			$("article").html(
				lt.templates.mc.render({
					frontname: deck.sides[front],
					backname: deck.sides[back],
					question: lt.content(q),
					answer0: lt.content(answers[0].sides[back]),
					answer1: lt.content(answers[1].sides[back]),
					answer2: lt.content(answers[2].sides[back]),
				})
			);
			
			lt.createProgress(deck, deck.cards.indexOf(sampleTarget));
			
			if (q.startsWith('img:'))
				$(".frame .question").addClass("image");
			else if (q.length < 4)
				$(".frame .question").addClass("short");
			else if (q.length < 10)
				$(".frame .question").addClass("medium");
				
			if (answers[0].sides[back].startsWith('img:'))
			{
				$(".frame #a0").addClass("image");
				$(".frame").addClass("image-answers");
			} 
			if (answers[1].sides[back].startsWith('img:'))
			{
				$(".frame #a1").addClass("image");
				$(".frame").addClass("image-answers");
			} 
			if (answers[2].sides[back].startsWith('img:'))
			{
				$(".frame #a2").addClass("image");
				$(".frame").addClass("image-answers");
			}
				
			$('.frame .question').addClass('side-'+front);
			$('.frame form').addClass('side-'+back); 
									
			// Add answer event handler
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
			      deck: deck.id,
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
				  correctAnswer: correct,
				  front: front,
				  back: back, 
				},
				lt.session.processMCAnswer
			)
			
			// Add keyboard shortcuts
			$(document).on('keydown', function(event) {
				if (event.key == 1)
				{
					$("article .frame button#a0").trigger('click')
					event.preventDefault();
				} else if (event.key == 2)
				{
					$("article .frame button#a1").trigger('click')					
					event.preventDefault();
				} else if (event.key == 3)
				{
					$("article .frame button#a2").trigger('click')					
					event.preventDefault();
				}
			});
            
		},
		
		/**
		 * Sample two alternatives for the given card. 
		 *
		 * If the score is low, alternatives are sampled uniformly. If the score is high,
		 * and similarity hints are available, we sample similar cards.
		 *
		 */
		sampleAlt : function(card, deck)
		{
			console.log('Sampling alts for ', card)
		
			// * Low score, sample easy alternatives
			if (card.score < 0.7)
				return lt.session.sampleAltUniform(card, deck);
				
			// * High score, try to sample difficult ones
			let cardIdx = deck.id2idx.get(card.id)

			if (! deck.sim.has(cardIdx))
				return lt.session.sampleAltUniform(card, deck);
				
			let sims = deck.sim.get(cardIdx);
			
			console.assert(sims.length > 0)
			
			if (sims.length == 1) // only one sim, add a uniform random second card
				return [ deck.cards[sims[0]] ].concat([_.sample(_.without(deck.cards, card))])
							
			let simCards = sims.map((idx) => {return deck.cards[idx]});

			let res = _.sampleSize(simCards, 2);
						
			return res
			
			// TODO: Add some noise with some probability
		},
		
		/**
		 * Sample two alternatives from the deck uniformly
		 */
		sampleAltUniform : function(card, deck)
		{
			return  _.sampleSize(_.without(deck.cards, card), 2);
		},
	
		processMCAnswer : function(e)
		{				
		    e.preventDefault(); // Stop the default form submit action.

			let edata = e.data // -- this is apparently required to stop some race conditions from JS re-using its event objects
			let etarget = e.target

			let btn = $(etarget)
			
			if (!btn.is('button'))
				btn = btn.parents('button')[0]
	
			let answered = $(btn).data('answer')
			let correct = edata.correctAnswer

			let newRow = 
			{
				timestamp: edata.timestamp,
				deck: edata.deck,
				card: edata.card,
				alt1: edata.alt1,
				alt2: edata.alt2,
				front: edata.front,
				back: edata.back,
 				questionType: 'mc',
 				correct: edata.correctAnswer == answered ? 1 : 0
			}
			
			lt.db.events.add(newRow).then (result =>
			{
			    console.log(newRow);
			}).catch('ConstraintError', er => 
			{
			    console.error ("Constraint error: " + er.message);
			    console.error(newrow);
			});

			lt.computeScores(lt.session.deck)
// 			.then(function() {		
// 				lt.session.updateProgress();
// 			});

			// --- todo: recompute only for current card


			if(answered == correct)
			{
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
				$(document).off('keydown')
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.sounds.incorrect.play()
			}
		},
	},

	/**
	 * Utility functions.
	 */	
	util : {	
	
	},
	
	/**
	 * Data stores.
	 */
	 
	 /**
	  * Dropbox 
	  */
	 dbx : {
	 	clientID : 'hu8kdrkpke73lhq',
	 	redirectURI : 'http://localhost:4000/?dbx=auth'
	 },
}

$(function() 
{
			
	// * Load page	
	lt.init().then(function() 
	{
	
		let params = new URLSearchParams(window.location.search);
		
		if (params.has('deck'))
		{
			if (params.has('list'))
			{
				// List all cards in the deck together with any information

				let deck = lt.decks[params.get('deck')]
				
				$("article").append($('<h1>').append(deck.name))

				$("article").append($('<ul>', {id: 'cards', class: 'cards'}));
				
				deck.cards.forEach((card, idx) =>
				{ 							
					let li = $('<li>', {class: 'card'});
					li.append($('<h3>').append('card ' + idx + ':'))
					
					let ulSides = $('<ul>', {class: 'sides'});					
					card.sides.forEach((side, j) =>
					{
						if (side.startsWith('img:'))
						{
							ulSides.append($('<li>', {class: 'side'}).append(j+':').append(
								$('<img>').attr('src', side.substring(4))
							));
						} else 
						{
							ulSides.append($('<li>', {class: 'side'}).append(j+':'+side));
						}
					});
										
					li.append(ulSides);
					li.append($('<span>', {class:'score'}).append('score: ' + card.score));
					
					$('ul#cards').append(li);
				});
				
			} else 
			{
				lt.session.startSession(lt.decks[params.get('deck')]);
			}
		} else if (params.has('dbx'))
		{
			// ** Dropbox connection
		
			lt.dbx.auth = new Dropbox.DropboxAuth(
			{
				clientId: lt.dbx.clientID
			});
		
			if (params.get('dbx') == 'start')
			{				
				let btn = $('<button>').append('connect to dropbox')
				
				$('article').append(btn)
				btn.on('click', function(){
			
					 lt.dbx.auth.getAuthenticationUrl(lt.dbx.redirectURI, undefined, 'code', 'offline', undefined, undefined, true)
					.then(authUrl => {
						window.sessionStorage.clear();
						window.sessionStorage.setItem("codeVerifier", lt.dbx.auth.codeVerifier);
						window.location.href = authUrl;
					})
					.catch((error) => console.error(error));
				});
				
			} else if (params.get('dbx') == 'auth') 
			{
			
			    lt.dbx.auth.setCodeVerifier(window.sessionStorage.getItem('codeVerifier'));
			    
				lt.dbx.auth.getAccessTokenFromCode(lt.dbx.redirectURI, params.get('code'))
        		.then((response) => 
                {
                    lt.dbx.auth.setAccessToken(response.result.access_token);
                    
                    lt.dbx.con = new Dropbox.Dropbox({
                        auth: lt.dbx.auth
                    })
                    
					return lt.db.export({ prettyJson: true , function (arg) {console.log(arg); } })
					.then(blob =>
					{
						lt.dbx.con.filesUpload({
							path: '/Apps/leitnr/db_dump.json',
							contents: blob
						});
					});
					
                    
                }).catch((error) => 
                {
                    console.error(error);
                    
                });
                
                
// 			        dbx.filesUpload({path: '/test.txt', contents: 'teeeeest.'})
			        
			        
			} else 
			{
				console.log('Not a valid state in the dropbox auth flow: ', params.get('dbx'));
			}
			
		} else
		{
			$('nav #session-info').addClass('hidden')
			$('nav #train').removeClass('hidden')

			
			// - Print the list of decks
			$("article").append('<p>No deck specified. Available decks:</p>')
			
			$("article").html($('<ul>', {id: 'decks', class: 'decks'}));
				
			lt.sortedDecks.forEach((deck, i) =>
			{
				console.log(deck, deck['numOver99'], deck.numOver99, deck.cards.length, (deck.numOver99 / deck.cards.length).toPrecision(2))
				
				$('ul#decks').append(
					lt.templates.decklink.render({
						href: '/?deck=' + deck.name,
						href_list: '/?deck=' + deck.name + '&list=true',
						name: deck.name,
						progress: (deck.numOver99 / deck.cards.length).toPrecision(2),
						num: i,
				}));
				
				lt.createProgress(deck, -1, `ul#decks li#deck-${i} div.progress`, true)
				
			});
			
			// * pick a random deck to train on
			let probMult; // 1 for very eager to move on, 10 for lots of revision
						
			let chosen = null;
			for (let deck of lt.sortedDecks) 
			{	
				let score99 = (deck.numOver99 / deck.cards.length);
				let prob = score99 < .9 ? 1.0 : (1.0 - score99) * probMult;
				// -- If the deck score is below .9, force training on this deck
				//    otherwise we train this deck with probability proportional to the 
				//    distances to .9
								
				if (_.random(0, 1, true) < prob)
				{
					chosen = deck;
					break;
				}						
			}
			
			if (chosen == null)
			{
				console.log('Choosing deck uniformly.')
				chosen = _.sample(lt.sortedDecks);
			}
			
			$('nav #train').on('click', function()
			{			
				window.location.replace(`/?deck=${chosen.name}&limit=${lt.defaultLimit}`);
			});
		}	
	});
	
	$('nav #full-screen').on('click', function(e){
	  if (!document.fullscreenElement) 
	  {
			$('body')[0].requestFullscreen()
			.catch(err => 
			{
				console.log(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
			});
	  } else 
	  {
			document.exitFullscreen();
	  }
	});
	
});