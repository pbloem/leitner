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
		let rqs = Array();
		for (let df of lt.deck_files)
		{
			let prm = $.getJSON(df).then(lt.loadDeck)
			rqs.push(prm);
		}
		
		await Promise.all(rqs)
	},
	
	// Add new decks here
	deck_files : [
		'../decks/hanzi01.json',
		'../decks/capitals.json',
	],
	
	// TODO: automate this in init(). Use a query to collect all script elements with type="text/x-jsrender"
	templates : { 
		mc: $.templates("#mc"), 
		decklink: $.templates("#decklink") 
	},
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : async function(deck) 
	{
	
		if (!( 'id' in deck))
			deck.id = (deck.name + '').hash()	
			
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
		
		console.log(deck.name + ' loaded');
		
		await lt.computeScores(deck);
		
		console.log(deck.name + ' scores computed');
		
		// Default order is by ID
		deck.cards = _.sortBy(deck.cards, [function(card){return card.id; }])
	},
	
	sigmoid : function(x) 
	{
		return 1.0 / (1 + Math.exp(-x))
	},

	// Parameters of first predictor
	mean : - 538986862113.73,
	std : 763822940584.4149 / 1e1,

	computeScores : async function(deck)
	{
	
		for (let card of deck.cards) 
		{
			
			await lt.db.events // latest seen
 				.where('[deck+card]').equals([deck.id,card.id]).reverse().sortBy('timestamp')
 				.then(function(events)
 				{
 					if (events.length > 0)
						card.timeSinceSeen = Date.now() - events[0].timestamp;
 				});

			await lt.db.events // latest correct
				.where('[deck+card+correct]').equals([deck.id,card.id,1]).reverse()
 				.sortBy('timestamp').then(function(events) 
				{				
					if (events.length > 0)
						card.timeSinceCorrect = Date.now() - events[0].timestamp;
				});
								
			await lt.db.events // latest incorrect (this currently works only for MC)
				.where('[deck+card+correct]').equals([deck.id,card.id,0]).reverse().sortBy('timestamp')
				.then(function(events)
				{
					if (events.length > 0)
						card.timeSinceIncorrect = Date.now() - events[0].timestamp;
				});

			if (card.timeSinceSeen === undefined)
				card.timeSinceSeen = Date.now()

			// Compute score logit
			// -- This is n unbounded value. The more negative it is, the more likely the 
			//    user will get the card wrong.
			card.score_logit = (- card.timeSinceSeen - lt.mean)/ lt.std

			card.score = lt.sigmoid(card.score_logit)		
		}		
	},
	
	/** 
	 * Sub-namespace for the current session
	 *
	 */
	session : {
	
		startSession : async function(deck)
		{

			lt.session.deck = deck
						
			lt.session.generate();
		},
		
		/**
		 * Sample a card from the deck according to the scores. 
		 *
		 * The strategy is to sample cards whose probability of being answered correclty 
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
			console.log('pivot time since seen', humanizeDuration(deck.cards[target].timeSinceSeen), deck.cards[target].timeSinceSeen)
						
			return deck.cards[target]
		},
		
		
	 	/**
		 * Sample a card from the deck according to the scores. 
		 *
		 * The strategy is to keep the cards sorted, and to move from left to right, 
		 * letting the probability of answering the card incorrectly be the probability 
		 * that the card is sampled.
		 *
		 * NB: Assumes that the cards maintain a fixed order.
		 */
		sampleSeq : function()
		{
			let deck = lt.session.deck;

			for (let card of deck.cards)
			{
				let r = _.random(0,1,true);
				if (r > card.score)
					return card;	
			}

			return _.sample(deck.cards);
		},
	
		generate : function() 
		{
			let deck = lt.session.deck
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			let sampleTarget = lt.session.sampleSeq()
			
			console.log(sampleTarget.sides[0], 'score', sampleTarget.score);
			console.log('time since seen', humanizeDuration(sampleTarget.timeSinceSeen));
			
			
			let sampleAlt = _.sampleSize(_.without(deck.cards, [sampleTarget]), 2)
			let sample = [sampleTarget].concat(sampleAlt)
						
			let ord = _.shuffle([0, 1, 2]); // random order of the answers
			let correct = ord[0]
			
			let answers = [undefined, undefined, undefined]
			answers[ord[0]] = sample[0]
			answers[ord[1]] = sample[1]			
			answers[ord[2]] = sample[2]

			let q = sampleTarget.sides[0];

			$("article").html(
				lt.templates.mc.render({
					question: q,
					answer0: answers[0].sides[1],
					answer1: answers[1].sides[1],
					answer2: answers[2].sides[1]
				})
			);
			
			lt.session.createProgress(deck.cards.indexOf(sampleTarget));
			
			if (q.length < 4)
				$(".frame .question").addClass("short")
			else if (q.length < 10)
				$(".frame .question").addClass("medium")
			
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
			      deck: deck.id,
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
				  correctAnswer: correct, 
				},
				lt.session.processAnswer
			)            
		},
	
		processAnswer : function(e)
		{		
			let edata = e.data // -- this is apparently required to stop some race conditions from JS re-using its event objects
			let etarget = e.target
		
			let answered = $(etarget).data('answer')
			let correct = edata.correctAnswer

			let newRow = 
			{
				timestamp: edata.timestamp,
				deck: edata.deck,
				card: edata.card,
				alt1: edata.alt1,
				alt2: edata.alt2,
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
			
				setTimeout(lt.session.generate , 750)
			} else
			{
				lt.sounds.incorrect.play()
			}
		},
		
		createProgress : function(targetIdx)
		{
			let scores = lt.session.deck.cards.map((card) => card.score);
			let pix = 4
			
			const parent = d3.select('div.progress')
			const svg = parent.append('svg')
			
			svg.attr('width', pix * scores.length)
			   .attr('height', 2*pix)
// 			   .attr("style", "outline: thin solid red;")
			    
			let xCoord = function(i) {return i == targetIdx ? i * pix - (pix/2) : i * pix};
			let yCoord = function(i) {return i == targetIdx ? 0 : pix/2};
			
			const prog = svg.selectAll("g")
				.data(scores)
				.join("g")
					.attr("transform", (d, i) => `translate(${xCoord(i)}, ${yCoord(i)})`);
					
					
					
			var colorScale = d3.scaleSequential(d3.interpolateRdYlGn)
    			.domain([0.0, 1.0])
    								
			prog.append("rect")
				.attr("fill", "steelblue")
				.attr("width", (score, i) => {return i == targetIdx ? 2*pix : pix})
				.attr("height", (score, i) => {return i == targetIdx ? 2*pix : pix})
				.attr('fill', (score, i) => {return colorScale(score);})

				
			// todo: would be nicer to update this rather than redraw every time									
				
		}, 
		

	},

	/**
	 * Utility functions.
	 */	
	util : {	
	
	},

}

$(function() 
{
// 
// 	// - init environment
// 	let defer = lt.init();
			
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
						ulSides.append($('<li>', {class: 'side'}).append(j+':'+side));
					});
										
					li.append(ulSides);
					li.append($('<span>', {class:'score'}).append('score: ' + card.score));
					
					$('ul#cards').append(li);
				});
				
			} else 
			{
				lt.session.startSession(lt.decks[params.get('deck')]);
			}
		} else
		{
			// - Print the list of decks
			$("article").append('<p>No deck specified. Available decks:</p>')
			
			$("article").html($('<ul>', {id: 'decks', class: 'decks'}));
			
			console.log(lt.templates)
			
			for (let [name, deck] of Object.entries(lt.decks)) 
			{ 
				$('ul#decks').append(
					lt.templates.decklink.render({
						href: '/?deck=' + name,
						href_list: '/?deck=' + name + '&list=true',
						text: name
				}));
			}
						
			
		}	
	});


});